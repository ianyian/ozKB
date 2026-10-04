// HTTP server: operations console + knowledge portal (static UI) and the JSON API behind them.
// Schedulers run inside this process; start/stop/run them from the console.
import express from "express";
import path from "node:path";
import { initDb, q, one, dbKind, ROOT } from "./db.js";
import { loadConfig, cfg, setConfig, log, enqueue, DEFAULT_CONFIG, CONFIG_HELP } from "./ops.js";
import { schedulers, stopAll, waitIdle, fastForward, runFastForward } from "./scheduler.js";
import { simState, resetAll, timeline, ensureStore } from "./sim/runner.js";
import { storeReady } from "./sim/store.js";
import { portal } from "./portal.js";
import { contentTerms } from "./text.js";

await initDb();
await loadConfig();
await simState();
await ensureStore();

const app = express();
app.use(express.json());
app.use(portal);
app.use(express.static(path.join(ROOT, "public")));
app.use("/vendor/marked.js", express.static(path.join(ROOT, "node_modules/marked/lib/marked.umd.js")));

const ADMIN = process.env.ADMIN_PASSWORD || "";
const guard = (req, res, next) => {
  if (!ADMIN || req.get("x-admin-key") === ADMIN) return next();
  res.status(401).json({ error: "Admin password required for this action." });
};
const h = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: e.message }); });
const n = async (sql, p = []) => Number((await one(sql, p)).n);

// ---------- status & dashboard ----------
app.get("/api/status", h(async (req, res) => {
  const s = await simState();
  res.json({
    db: dbKind, store: storeReady(), admin_required: !!ADMIN, llm: { provider: cfg("llm.provider"), model: cfg("llm.model"), hf_token: !!process.env.HF_TOKEN },
    sim: { seed: s.seed, cursor: s.cursor, total: s.total_events, sim_clock: s.sim_clock, reset_at: s.reset_at },
    schedulers: Object.values(schedulers).map((x) => x.status()),
    fast_forward: fastForward,
  });
}));

app.get("/api/dashboard", h(async (req, res) => {
  const [tickets, cards, docs, commits, units, groups, openReview, errors1h] = await Promise.all([
    n("SELECT count(*) n FROM tickets"), n("SELECT count(*) n FROM cards"), n("SELECT count(*) n FROM documents"), n("SELECT count(*) n FROM commits"),
    n("SELECT count(*) n FROM code_units"), n("SELECT count(*) n FROM clone_groups"), n("SELECT count(*) n FROM review_items WHERE status='open'"),
    n("SELECT count(*) n FROM logs WHERE level='error' AND ts > now() - interval '1 hour'"),
  ]);
  const queue = await q("SELECT stage, status, count(*)::int n FROM jobs GROUP BY 1,2");
  const tiers = await q("SELECT link_confidence k, count(*)::int n FROM cards GROUP BY 1");
  const reviewKinds = await q("SELECT kind k, count(*)::int n FROM review_items WHERE status='open' GROUP BY 1");
  const thr = await q(`SELECT stage, to_char(date_trunc('minute', finished_at), 'HH24:MI') m, count(*)::int n FROM jobs
                       WHERE status='done' AND finished_at > now() - interval '30 minutes' GROUP BY 1,2 ORDER BY 2`);
  const sites = await q("SELECT site k, count(*)::int n FROM tickets GROUP BY 1 ORDER BY 1");
  const recent = await q("SELECT id, scheduler, status, started_at, finished_at, picked, done, failed, note FROM runs ORDER BY id DESC LIMIT 8");
  const lastErrors = await q("SELECT id, ts, stage, task, message FROM logs WHERE level='error' ORDER BY id DESC LIMIT 5");
  res.json({ counts: { tickets, cards, docs, commits, units, groups, openReview, errors1h }, queue, tiers, reviewKinds, throughput: thr, sites, recent, lastErrors });
}));

// ---------- schedulers & admin ----------
app.post("/api/scheduler/:name/:action", guard, h(async (req, res) => {
  const names = req.params.name === "all" ? Object.keys(schedulers) : [req.params.name];
  for (const name of names) {
    const s = schedulers[name];
    if (!s) return res.status(404).json({ error: `No scheduler ${name}` });
    if (req.params.action === "start") s.start();
    else if (req.params.action === "stop") s.stop();
    else if (req.params.action === "run") await s.runOnce("manual");
    else return res.status(400).json({ error: "action must be start, stop or run" });
    await log("info", "ADMIN", `${s.label}: ${req.params.action}`);
  }
  res.json({ ok: true, schedulers: Object.values(schedulers).map((x) => x.status()) });
}));

app.post("/api/admin/reset", guard, h(async (req, res) => {
  stopAll();
  await waitIdle();
  await resetAll(req.body && req.body.by ? String(req.body.by) : "console");
  res.json({ ok: true });
}));

app.post("/api/admin/load-full-demo", guard, h(async (req, res) => {
  if (fastForward.running) return res.status(409).json({ error: "Already loading." });
  if (req.body && req.body.reset) { stopAll(); await waitIdle(); await resetAll("load full demo"); }
  runFastForward();
  res.json({ ok: true });
}));

app.get("/api/config", h(async (req, res) => {
  const rows = await q("SELECT key, value, updated_at, updated_by FROM config ORDER BY key");
  res.json(rows.map((r) => ({ ...r, default: DEFAULT_CONFIG[r.key], help: CONFIG_HELP[r.key] })));
}));
app.post("/api/config", guard, h(async (req, res) => {
  const changed = [];
  for (const [k, v] of Object.entries(req.body || {})) if (await setConfig(k, v, "console")) changed.push(k);
  res.json({ ok: true, changed });
}));
app.get("/api/config/audit", h(async (req, res) => res.json(await q("SELECT * FROM config_audit ORDER BY id DESC LIMIT 50"))));

// ---------- jobs, logs, runs ----------
app.get("/api/jobs", h(async (req, res) => {
  const { stage, status, task } = req.query;
  const where = [], p = [];
  if (stage) { p.push(stage); where.push(`stage=$${p.length}`); }
  if (status) { p.push(status); where.push(`status=$${p.length}`); }
  if (task) { p.push(task); where.push(`task=$${p.length}`); }
  const rows = await q(`SELECT id, stage, kind, ref, task, status, attempts, run_id, created_at, started_at, finished_at, error IS NOT NULL AS has_error
                        FROM jobs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT 200`, p);
  const counts = await q("SELECT stage, status, count(*)::int n FROM jobs GROUP BY 1,2");
  res.json({ rows, counts });
}));
app.get("/api/jobs/:id", h(async (req, res) => {
  const job = await one("SELECT * FROM jobs WHERE id=$1", [req.params.id]);
  if (!job) return res.status(404).json({ error: "No such job" });
  res.json({ job, logs: await q("SELECT * FROM logs WHERE job_id=$1 ORDER BY id", [job.id]) });
}));
app.post("/api/jobs/:id/retry", guard, h(async (req, res) => {
  await q("UPDATE jobs SET status='pending', error=NULL WHERE id=$1 AND status='failed'", [req.params.id]);
  res.json({ ok: true });
}));
app.get("/api/logs", h(async (req, res) => {
  const { level, stage, task, text, before } = req.query;
  const where = [], p = [];
  if (level) { p.push(level.split(",")); where.push(`level = ANY($${p.length})`); }
  if (stage) { p.push(stage); where.push(`stage=$${p.length}`); }
  if (task) { p.push(task); where.push(`task=$${p.length}`); }
  if (text) { p.push(`%${text}%`); where.push(`message ILIKE $${p.length}`); }
  if (before) { p.push(before); where.push(`id < $${p.length}`); }
  res.json(await q(`SELECT * FROM logs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT 300`, p));
}));
app.get("/api/runs", h(async (req, res) => {
  const p = [], w = req.query.scheduler ? (p.push(req.query.scheduler), "WHERE scheduler=$1") : "";
  res.json(await q(`SELECT *, extract(epoch FROM (finished_at - started_at)) AS secs FROM runs ${w} ORDER BY id DESC LIMIT 200`, p));
}));
app.get("/api/trace/:task", h(async (req, res) => {
  const t = req.params.task;
  res.json({
    jobs: await q("SELECT id, stage, kind, ref, status, created_at, started_at, finished_at FROM jobs WHERE task=$1 OR (stage='L2' AND ref=$1) ORDER BY id", [t]),
    logs: await q("SELECT id, ts, level, stage, message FROM logs WHERE task=$1 ORDER BY id", [t]),
  });
}));

// ---------- review ----------
app.get("/api/review", h(async (req, res) => {
  res.json(await q("SELECT * FROM review_items WHERE status=$1 ORDER BY id DESC LIMIT 200", [req.query.status || "open"]));
}));
app.post("/api/review/:id", guard, h(async (req, res) => {
  const it = await one("SELECT * FROM review_items WHERE id=$1", [req.params.id]);
  if (!it) return res.status(404).json({ error: "No such item" });
  const decision = req.body.decision === "approve" ? "approved" : "rejected";
  const by = req.body.by || "domain expert";
  await q("UPDATE review_items SET status=$2, decided_at=now(), decided_by=$3 WHERE id=$1", [it.id, decision, by]);
  if (["inferred_link", "clone"].includes(it.kind) && it.task) {
    if (decision === "approved") {
      await q(`INSERT INTO links (task, repo, commit_sha, tier, evidence, score, source) VALUES ($1,$2,$3,'strong',$4,1,'expert')
               ON CONFLICT (task, repo, commit_sha, tier) DO UPDATE SET source='expert'`, [it.task, it.detail.repo, it.detail.commit, `Confirmed by ${by}. ${it.detail.evidence}`]);
    } else {
      await q("UPDATE links SET status='rejected' WHERE task=$1 AND commit_sha=$2 AND tier='inferred'", [it.task, it.detail.commit]);
    }
    await enqueue("L2", "card", it.task, it.task);
  }
  await log("info", "ADMIN", `Review #${it.id} (${it.kind}) ${decision} by ${by}`, null, { task: it.task });
  res.json({ ok: true });
}));

// ---------- knowledge portal ----------
app.get("/api/search", h(async (req, res) => {
  const text = String(req.query.q || "").trim();
  const site = req.query.site || null;
  if (!text) return res.json({ results: [] });
  const id = text.match(/^(\d{6})(?:-(\d{2}))?$/);
  if (id) {
    const t = id[2] ? await one("SELECT task FROM tickets WHERE task=$1", [text]) : await one("SELECT task FROM tickets WHERE cr=$1 ORDER BY rev LIMIT 1", [id[1]]);
    if (t) return res.json({ jump: id[2] ? `#/ticket/${t.task}` : `#/family/${id[1]}` });
  }
  // Match on meaningful words; a result needs at least half of them, ranked by how many it has.
  const words = [...new Set(contentTerms(text).map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean))];
  if (!words.length) return res.json({ results: { cards: [], docs: [], code: [] }, words });
  const orq = words.join(" | ");
  const need = Math.max(1, Math.ceil(words.length / 2));
  const p = [orq, site, words, need];
  const cards = await q(`SELECT * FROM (
                           SELECT c.task, t.title, t.site, t.state, c.link_confidence, c.overview,
                             ts_rank(c.search, to_tsquery('english', $1)) rank,
                             (SELECT count(*)::int FROM unnest($3::text[]) w WHERE c.search @@ to_tsquery('english', w)) hits,
                             ts_headline('english', c.overview, to_tsquery('english', $1), 'MaxWords=40, MinWords=15') snippet
                           FROM cards c JOIN tickets t USING (task)
                           WHERE c.search @@ to_tsquery('english', $1) AND ($2::text IS NULL OR t.site=$2)) x
                         WHERE hits >= $4 ORDER BY hits DESC, rank DESC LIMIT 20`, p);
  const docs = await q(`SELECT * FROM (
                          SELECT d.task, d.file_name, d.format, ts_headline('english', d.markdown, to_tsquery('english', $1), 'MaxWords=30, MinWords=10') snippet,
                            ts_rank(d.search, to_tsquery('english', $1)) rank,
                            (SELECT count(*)::int FROM unnest($3::text[]) w WHERE d.search @@ to_tsquery('english', w)) hits
                          FROM documents d JOIN tickets t USING (task)
                          WHERE d.search @@ to_tsquery('english', $1) AND ($2::text IS NULL OR t.site=$2)) x
                        WHERE hits >= $4 ORDER BY hits DESC, rank DESC LIMIT 10`, p);
  // Code: identifiers are split into words; copies collapse to one hit per clone group.
  const code = await q(`SELECT * FROM (
                          SELECT DISTINCT ON (coalesce(m.group_id, -u.id)) u.id, u.repo, u.path, u.name, u.lang, u.doc, m.group_id,
                            (SELECT count(*)::int FROM clone_members m2 WHERE m2.group_id = m.group_id) - 1 AS copies,
                            (SELECT count(*)::int FROM unnest($2::text[]) w WHERE u.search @@ to_tsquery('simple', w) OR lower(u.name) LIKE '%' || w || '%') hits
                          FROM code_units u LEFT JOIN clone_members m ON m.unit_id=u.id
                          WHERE u.search @@ to_tsquery('simple', $1) OR EXISTS (SELECT 1 FROM unnest($2::text[]) w WHERE lower(u.name) LIKE '%' || w || '%')
                          ORDER BY coalesce(m.group_id, -u.id), m.role = 'origin' DESC) x
                        WHERE hits >= $3 ORDER BY hits DESC, name LIMIT 15`, [orq, words, need]);
  res.json({ results: { cards, docs, code }, words });
}));

app.get("/api/tickets", h(async (req, res) => {
  const { site, state, confidence } = req.query;
  const where = [], p = [];
  if (site) { p.push(site); where.push(`t.site=$${p.length}`); }
  if (state) { p.push(state); where.push(`t.state=$${p.length}`); }
  if (confidence) { p.push(confidence); where.push(`c.link_confidence=$${p.length}`); }
  res.json(await q(`SELECT t.task, t.cr, t.rev, t.title, t.site, t.customer, t.region, t.state, t.created, t.edit_no, c.link_confidence, c.version, c.status card_status
                    FROM tickets t LEFT JOIN cards c USING (task) ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY t.task DESC`, p));
}));

app.get("/api/ticket/:task", h(async (req, res) => {
  const task = req.params.task;
  const t = await one("SELECT * FROM tickets WHERE task=$1", [task]);
  if (!t) return res.status(404).json({ error: `Ticket ${task} is not in the knowledge base yet.` });
  delete t.search;
  const card = await one("SELECT task, version, template_version, card_md, link_confidence, status, model, tokens_in, tokens_out, generated_at FROM cards WHERE task=$1", [task]);
  res.json({
    ticket: t, card,
    card_versions: await q("SELECT version, model, generated_at FROM card_history WHERE task=$1 ORDER BY version DESC", [task]),
    versions: await q("SELECT edit_no, captured_at, snapshot->>'state' AS state, snapshot->>'required' AS required FROM ticket_versions WHERE task=$1 ORDER BY edit_no DESC", [task]),
    family: await q("SELECT task, title, state, site FROM tickets WHERE cr=$1 ORDER BY rev", [t.cr]),
    documents: await q("SELECT id, file_name, format, chars, markdown FROM documents WHERE task=$1 ORDER BY file_name", [task]),
    links: await q("SELECT l.*, c.message, c.author, c.committed_at FROM links l LEFT JOIN commits c ON c.sha=l.commit_sha WHERE l.task=$1 ORDER BY l.status, c.committed_at", [task]),
    similar: await q("SELECT s.task_b task, s.score, t.title, t.site FROM similar_tickets s JOIN tickets t ON t.task=s.task_b WHERE s.task_a=$1 ORDER BY s.score DESC LIMIT 5", [task]),
    review: await q("SELECT id, kind, title, status FROM review_items WHERE task=$1 ORDER BY id DESC", [task]),
  });
}));
app.get("/api/family/:cr", h(async (req, res) => {
  res.json({ cr: req.params.cr, tickets: await q("SELECT t.*, c.link_confidence, c.overview FROM tickets t LEFT JOIN cards c USING (task) WHERE cr=$1 ORDER BY rev", [req.params.cr]) });
}));
app.get("/api/repo/:name", h(async (req, res) => {
  const name = req.params.name;
  res.json({
    repo: name,
    commits: await q("SELECT c.*, (SELECT json_agg(json_build_object('task', l.task, 'tier', l.tier, 'source', l.source)) FROM links l WHERE l.commit_sha=c.sha AND l.status='active') AS links FROM commits c WHERE repo=$1 ORDER BY committed_at DESC", [name]),
    units: await q(`SELECT u.id, u.path, u.name, u.kind, u.lang, u.start_line, u.end_line, u.doc, m.group_id, m.role, m.similarity
                    FROM code_units u LEFT JOIN clone_members m ON m.unit_id=u.id WHERE repo=$1 ORDER BY path, start_line`, [name]),
  });
}));
app.get("/api/code/:id", h(async (req, res) => {
  const u = await one("SELECT * FROM code_units WHERE id=$1", [req.params.id]);
  if (!u) return res.status(404).json({ error: "No such code unit" });
  delete u.search; delete u.minhash;
  const group = await q(`SELECT g.id, u2.id unit_id, u2.repo, u2.path, u2.name, m2.role, m2.similarity FROM clone_members m JOIN clone_groups g ON g.id=m.group_id
                         JOIN clone_members m2 ON m2.group_id=g.id JOIN code_units u2 ON u2.id=m2.unit_id WHERE m.unit_id=$1 ORDER BY g.id, m2.role DESC`, [u.id]);
  const links = await q("SELECT DISTINCT task, tier FROM links WHERE repo=$1 AND status='active'", [u.repo]);
  res.json({ unit: u, group, links });
}));
app.get("/api/sites", h(async (req, res) => {
  res.json(await q(`SELECT t.site, t.region, t.customer, count(*)::int tickets, count(DISTINCT t.capability)::int capabilities,
                      count(c.task) FILTER (WHERE c.link_confidence <> 'unlinked')::int linked
                    FROM tickets t LEFT JOIN cards c USING (task) GROUP BY 1,2,3 ORDER BY 1`));
}));
app.get("/api/site/:site", h(async (req, res) => {
  res.json(await q(`SELECT t.task, t.title, t.state, t.capability, c.link_confidence FROM tickets t LEFT JOIN cards c USING (task) WHERE t.site=$1 ORDER BY t.capability, t.task`, [req.params.site]));
}));
app.get("/api/health", h(async (req, res) => {
  const t0 = Date.now(); await one("SELECT 1 AS n");
  res.json({ db: { kind: dbKind, ok: true, ms: Date.now() - t0 }, store: storeReady(), hf_token: !!process.env.HF_TOKEN, timeline_events: timeline(cfg("sim.seed")).events.length });
}));

const port = Number(process.env.PORT || 7860);
app.listen(port, () => console.log(`KB Hub prototype on http://localhost:${port} (database: ${dbKind})`));
if (process.env.AUTOSTART === "1") Object.values(schedulers).forEach((s) => s.start());
