// L2 · Knowledge cards. Links commits to CRs with confidence tiers, detects code clones,
// finds similar tickets, writes one knowledge card per task revision and indexes it (L3).
import { q, one } from "./db.js";
import { log, enqueue, claim, complete, fail, cfg, sleep } from "./ops.js";
import { minhashSim, tfidf, cosine, words, codeTokens } from "./text.js";
import { writeCard } from "./cards.js";

const MIN_CLONE_TOKENS = 30;

const TASK_RE = /(?:FLEXPM|CR)\s*#?(\d{6})-(\d{2})/i;

export async function processBatch(runId) {
  const jobs = await claim("L2", cfg("l2.batch_size"), runId);
  let done = 0, failed = 0;
  const one = async (job) => {
    const ctx = { runId, jobId: job.id, task: job.task };
    try {
      await sleep(cfg("demo.item_delay_ms"));
      const after = job.kind === "repo" ? await doRepo(job, ctx) : await doCard(job, ctx);
      await complete(job, after);
      await log("info", "L2", after.summary, after, ctx);
      done++;
    } catch (e) {
      await fail(job, e);
      await log("error", "L2", `Failed ${job.kind} ${job.ref}: ${e.message}`, { stack: String(e.stack).slice(0, 800) }, ctx);
      failed++;
    }
  };
  // Repo jobs (links, clone groups) run one at a time; card jobs for different tickets run 8 at a time.
  for (const job of jobs.filter((j) => j.kind === "repo")) await one(job);
  const cards = jobs.filter((j) => j.kind !== "repo");
  await Promise.all(Array.from({ length: Math.min(8, cards.length) }, async () => { while (cards.length) await one(cards.shift()); }));
  return { picked: jobs.length, done, failed };
}

// ---------------- repo: clones + links ----------------
async function doRepo(job, ctx) {
  const repo = job.ref;
  const clones = await detectClones(repo, ctx);
  const commits = await q("SELECT * FROM commits WHERE repo=$1 ORDER BY committed_at", [repo]);
  const results = [];
  const touched = new Set();
  for (const c of commits) {
    const link = await linkCommit(repo, c);
    results.push(`${c.sha.slice(0, 7)} → ${link.task || "unlinked"} (${link.tier})`);
    if (link.task) touched.add(link.task);
  }
  for (const t of touched) await enqueue("L2", "card", t, t);
  return { summary: `Linked ${commits.length} commit(s) in ${repo}; ${clones.length} clone match(es)`, repo, links: results, clones };
}

async function linkCommit(repo, c) {
  const flex = repo.match(/FLEXPM(\d{6})/);
  const m = c.message.match(TASK_RE);
  const exists = async (t) => !!(await one("SELECT 1 FROM tickets WHERE task=$1", [t]));
  // Confirmed: repo name carries the CR and the commit names the revision (or the revision is chosen by date).
  if (flex) {
    let task = m && m[1] === flex[1] ? `${m[1]}-${m[2]}` : null;
    if (!task) {
      const r = await one("SELECT task FROM tickets WHERE cr=$1 AND created <= $2 ORDER BY rev DESC LIMIT 1", [flex[1], c.committed_at]);
      task = r && r.task;
    }
    if (task && (await exists(task))) {
      await upsertLink(task, repo, c.sha, "confirmed", m ? `Repo name contains FLEXPM${flex[1]}; commit message names ${task}` : `Repo name contains FLEXPM${flex[1]}; revision chosen by commit date`, 1);
      return { task, tier: "confirmed" };
    }
    return { task: null, tier: "waiting for ticket" };
  }
  // Strong: CR number in the commit message.
  if (m && (await exists(`${m[1]}-${m[2]}`))) {
    const task = `${m[1]}-${m[2]}`;
    await upsertLink(task, repo, c.sha, "strong", `Commit message "${c.message}" names ${task}`, 0.9);
    return { task, tier: "strong" };
  }
  // Inferred via clone: the changed code is a copy of code that belongs to a CR.
  const viaClone = await one(`
    SELECT l.task, cm2.similarity, u2.repo AS origin_repo, u2.path AS origin_path
      FROM code_units u
      JOIN clone_members cm ON cm.unit_id = u.id
      JOIN clone_members cm2 ON cm2.group_id = cm.group_id AND cm2.unit_id <> u.id
      JOIN code_units u2 ON u2.id = cm2.unit_id
      JOIN commits c2 ON c2.sha = u2.commit_sha
      JOIN links l ON l.repo = u2.repo AND l.status='active' AND l.tier IN ('confirmed','strong')
      JOIN tickets lt ON lt.task = l.task
     WHERE u.repo=$1 AND u.path = ANY($2) AND c2.committed_at < $3 AND lt.created <= $3
     ORDER BY CASE l.tier WHEN 'confirmed' THEN 0 ELSE 1 END, cm.similarity DESC LIMIT 1`, [repo, c.files, c.committed_at]);
  if (viaClone) {
    const sim = await one("SELECT max(cm.similarity) s FROM code_units u JOIN clone_members cm ON cm.unit_id=u.id WHERE u.repo=$1 AND u.path = ANY($2)", [repo, c.files]);
    const ev = `Code is a copy of ${viaClone.origin_repo}/${viaClone.origin_path} (similarity ${Number(sim.s).toFixed(2)}), which implements ${viaClone.task}. No CR in commit "${c.message}".`;
    await upsertLink(viaClone.task, repo, c.sha, "inferred", ev, Number(sim.s));
    await review("clone", `${c.sha}`, viaClone.task, `Plug-and-play copy in ${repo} → ${viaClone.task}?`, { repo, commit: c.sha, message: c.message, evidence: ev });
    return { task: viaClone.task, tier: "inferred" };
  }
  // Inferred via text: compare the changed code with ticket text written before the commit.
  const units = await q("SELECT name, doc FROM code_units WHERE repo=$1 AND path = ANY($2)", [repo, c.files]);
  const codeText = [c.message, ...units.map((u) => `${u.name} ${u.doc || ""}`)].join(" ");
  const cands = await q("SELECT task, title, body_md, region, customer FROM tickets WHERE created <= $1", [c.committed_at]);
  if (cands.length && words(codeText).length) {
    const vecs = tfidf([codeText, ...cands.map((t) => `${t.title} ${t.body_md}`)]);
    let best = null;
    // Hint: a legacy repo belongs to one region and customer, so tickets of that customer score higher.
    const hint = (t) => (repo.startsWith(`${t.region}-${t.customer}-`) ? 0.1 : 0);
    cands.forEach((t, i) => { const s = cosine(vecs[0], vecs[i + 1]) + hint(t); if (!best || s > best.s) best = { t, s }; });
    if (best && best.s >= cfg("link.inferred_threshold")) {
      const ev = `Text similarity ${best.s.toFixed(2)} (incl. customer hint) between changed code (${units.map((u) => u.name).join(", ") || "—"}) and ${best.t.task} "${best.t.title}"; commit message "${c.message}" has no CR.`;
      await upsertLink(best.t.task, repo, c.sha, "inferred", ev, best.s);
      await review("inferred_link", c.sha, best.t.task, `Is commit ${c.sha.slice(0, 7)} in ${repo} part of ${best.t.task}?`, { repo, commit: c.sha, message: c.message, evidence: ev, score: best.s });
      return { task: best.t.task, tier: "inferred" };
    }
  }
  await review("unlinked", c.sha, null, `No CR found for commit ${c.sha.slice(0, 7)} in ${repo}`, { repo, commit: c.sha, message: c.message, files: c.files });
  return { task: null, tier: "unlinked" };
}

async function upsertLink(task, repo, sha, tier, evidence, score) {
  const rejected = await one("SELECT 1 FROM links WHERE task=$1 AND repo=$2 AND commit_sha=$3 AND status='rejected'", [task, repo, sha]);
  if (rejected) return;
  await q(`INSERT INTO links (task, repo, commit_sha, tier, evidence, score) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (task, repo, commit_sha, tier) DO UPDATE SET evidence=$5, score=$6`, [task, repo, sha, tier, evidence, score]);
}

async function review(kind, ref, task, title, detail) {
  await q(`INSERT INTO review_items (kind, ref, task, title, detail) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (kind, ref) DO NOTHING`,
    [kind, ref, task, title, JSON.stringify(detail)]);
}

// ---------------- clones ----------------
async function detectClones(repo, ctx) {
  // Tiny helpers (a few lines) look alike across unrelated features, so they are not compared.
  const sel = `SELECT u.id, u.repo, u.path, u.name, u.norm_hash, u.minhash, u.body, u.lang, c.committed_at
                 FROM code_units u LEFT JOIN commits c ON c.sha=u.commit_sha WHERE `;
  const big = (rows) => rows.filter((u) => codeTokens(u.body, u.lang).length >= MIN_CLONE_TOKENS);
  const mine = big(await q(sel + "u.repo=$1", [repo]));
  if (!mine.length) return [];
  const others = big(await q(sel + "u.repo<>$1", [repo]));
  const thr = cfg("clone.variant_threshold");
  const found = [];
  for (const a of mine) {
    for (const b of others) {
      const exact = a.norm_hash === b.norm_hash;
      const sim = exact ? 1 : minhashSim(a.minhash, b.minhash);
      if (!exact && sim < thr) continue;
      const [origin, copy] = new Date(a.committed_at) <= new Date(b.committed_at) ? [a, b] : [b, a];
      // One group per original: a copy (or a copy of a copy) joins the group its source already belongs to.
      const g = await one("SELECT id AS group_id FROM clone_groups WHERE origin_unit=$1", [origin.id])
        || await one("SELECT group_id FROM clone_members WHERE unit_id=$1 ORDER BY group_id LIMIT 1", [origin.id])
        || await one("SELECT group_id FROM clone_members WHERE unit_id=$1 ORDER BY group_id LIMIT 1", [copy.id]);
      let gid = g && g.group_id;
      if (!gid) {
        gid = (await one("INSERT INTO clone_groups (origin_unit, label) VALUES ($1,$2) RETURNING id", [origin.id, `${origin.name}`])).id;
        await log("info", "L2", `New clone group CG-${String(gid).padStart(4, "0")} for ${origin.name}`, { origin: `${origin.repo}/${origin.path}` }, ctx);
      }
      const originInGroup = await one("SELECT 1 FROM clone_members WHERE unit_id=$1", [origin.id]);
      if (!originInGroup) await q("INSERT INTO clone_members (group_id, unit_id, role, similarity) VALUES ($1,$2,'origin',1) ON CONFLICT DO NOTHING", [gid, origin.id]);
      if (await one("SELECT 1 FROM clone_members WHERE unit_id=$1 AND group_id<>$2", [copy.id, gid])) continue;
      await q("INSERT INTO clone_members (group_id, unit_id, role, similarity) VALUES ($1,$2,$3,$4) ON CONFLICT (group_id, unit_id) DO UPDATE SET similarity=$4, role=$3",
        [gid, copy.id, exact ? "exact" : "variant", sim]);
      found.push(`${a.name} ~ ${b.repo}/${b.name} (${exact ? "exact" : sim.toFixed(2)})`);
    }
  }
  return found;
}

// ---------------- card ----------------
async function doCard(job, ctx) {
  const task = job.ref;
  const t = await one("SELECT * FROM tickets WHERE task=$1", [task]);
  if (!t) return { summary: `Card for ${task} waits for the ticket`, waiting: true };
  const sims = await similar(t);
  const res = await writeCard(t, sims, ctx);
  if (res.unchanged) return { summary: `Card ${task} unchanged (v${res.version})`, version: res.version };
  await log("info", "L3", `Indexed card ${task} v${res.version} (${res.sections} sections, ${res.linkConfidence})`, null, ctx);
  return { summary: `Card ${task} → v${res.version} (${res.linkConfidence}, ${res.model})`, version: res.version, link_confidence: res.linkConfidence, model: res.model, similar: sims.map((s) => `${s.task} ${s.score.toFixed(2)}`) };
}

async function similar(t) {
  const all = await q(`SELECT t.task, t.title, t.site, t.cr, t.body_md, coalesce(string_agg(d.markdown, ' '), '') AS docs
                         FROM tickets t LEFT JOIN documents d ON d.task=t.task GROUP BY t.task`);
  const me = all.findIndex((x) => x.task === t.task);
  const vecs = tfidf(all.map((x) => `${x.title} ${x.body_md} ${x.docs}`));
  const out = [];
  all.forEach((x, i) => {
    if (i === me || x.cr === t.cr) return;
    const s = cosine(vecs[me], vecs[i]);
    if (s >= cfg("similar.threshold")) out.push({ task: x.task, title: x.title, site: x.site, score: s });
  });
  out.sort((a, b) => b.score - a.score);
  const top = out.slice(0, 5);
  await q("DELETE FROM similar_tickets WHERE task_a=$1", [t.task]);
  for (const s of top) {
    await q("INSERT INTO similar_tickets (task_a, task_b, score) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [t.task, s.task, s.score]);
    // Store the reverse too, so older tickets learn about newer look-alikes.
    await q("INSERT INTO similar_tickets (task_a, task_b, score) VALUES ($1,$2,$3) ON CONFLICT (task_a, task_b) DO UPDATE SET score=$3", [s.task, t.task, s.score]);
    const sameCap = await one("SELECT (a.capability = b.capability) same FROM tickets a, tickets b WHERE a.task=$1 AND b.task=$2", [t.task, s.task]);
    if (s.score >= cfg("similar.duplicate_threshold") && s.site !== t.site && !(sameCap && sameCap.same)) {
      // One flag per pair of CR families, not per revision.
      const pair = [t.cr, s.task.split("-")[0]].sort().join("~");
      await review("duplicate", pair, t.task, `Possible duplicate: CR ${t.cr} (${t.site}) and CR ${s.task.split("-")[0]} (${s.site})`, { a: t.task, b: s.task, score: s.score, a_title: t.title, b_title: s.title });
    }
  }
  return top;
}
