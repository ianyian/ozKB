// L1 · Normalization. Scans the raw store, detects changes by SHA-256, creates jobs,
// then converts tickets/attachments to Markdown and parses code into function-level units.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import * as acorn from "acorn";
import { q, one } from "./db.js";
import { SIM_DIR, storeReady } from "./sim/store.js";
import { sha256, codeTokens, minhash } from "./text.js";
import { log, enqueue, claim, complete, fail, cfg, sleep } from "./ops.js";

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(SIM_DIR, p).split(path.sep).join("/");

// 1) Scan: compare every file with the registry and queue the changed ones.
export async function scan(ctx) {
  if (!storeReady()) return { changed: 0, commits: 0 };
  const known = new Map((await q("SELECT path, sha256, size FROM source_files")).map((r) => [r.path, r]));
  let changed = 0;
  for (const full of [...walk(path.join(SIM_DIR, "mypm")), ...walk(path.join(SIM_DIR, "repos"))]) {
    const p = rel(full);
    const buf = fs.readFileSync(full);
    const h = sha256(buf);
    const prev = known.get(p);
    if (prev && prev.sha256 === h) continue;
    const parts = p.split("/");
    let kind, task = null, repo = null;
    if (parts[0] === "mypm") { task = parts[2]; kind = parts[3] === "ticket.json" ? "ticket" : "attachment"; }
    else { repo = parts[1]; kind = /\.(py|js)$/.test(p) ? "code" : null; }
    if (!kind) continue;
    await q(`INSERT INTO source_files (path, kind, task, repo, sha256, size) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (path) DO UPDATE SET sha256=$5, size=$6, last_change=now()`, [p, kind, task, repo, h, buf.length]);
    await enqueue("L1", kind, p, task, prev ? { change: "edited", sha256: prev.sha256.slice(0, 12), size: prev.size } : { change: "new", sha256: null });
    changed++;
  }
  const commits = await ingestCommits();
  if (changed || commits) await log("info", "L1", `Scan found ${changed} changed file(s) and ${commits} new commit(s)`, null, ctx);
  return { changed, commits };
}

async function ingestCommits() {
  const out = execFileSync("git", ["log", "--reverse", "--format=@@%H|%an|%aI|%s", "--name-only", "--", "repos/"], { cwd: SIM_DIR, encoding: "utf8", maxBuffer: 50e6 });
  // Only new commits cost a database round trip (Neon may be far away from the app).
  const known = new Set((await q("SELECT sha FROM commits")).map((r) => r.sha));
  let n = 0;
  for (const block of out.split("@@").filter(Boolean)) {
    const [head, ...files] = block.trim().split("\n");
    const [sha, author, at, ...msg] = head.split("|");
    if (known.has(sha)) continue;
    const fl = files.filter(Boolean);
    const repo = fl[0] ? fl[0].split("/")[1] : null;
    if (!repo) continue;
    const r = await q("INSERT INTO commits (sha, repo, message, author, committed_at, files) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING sha",
      [sha, repo, msg.join("|"), author, at, fl.map((f) => f.split("/").slice(2).join("/"))]);
    n += r.length;
  }
  return n;
}

// 2) Process queued jobs.
export async function processBatch(runId) {
  const jobs = await claim("L1", cfg("l1.batch_size"), runId);
  let done = 0, failed = 0;
  // Jobs touch different files, so up to 8 run in parallel to hide database latency.
  await pool(jobs, 8, async (job) => {
    const ctx = { runId, jobId: job.id, task: job.task };
    try {
      await sleep(cfg("demo.item_delay_ms"));
      const after = job.kind === "ticket" ? await doTicket(job) : job.kind === "attachment" ? await doAttachment(job) : await doCode(job);
      await complete(job, after);
      await log("info", "L1", after.summary, after, ctx);
      done++;
    } catch (e) {
      await fail(job, e);
      await log("error", "L1", `Failed ${job.kind} ${job.ref}: ${e.message}`, null, ctx);
      failed++;
    }
  });
  return { picked: jobs.length, done, failed };
}

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => { while (queue.length) await fn(queue.shift()); }));
}

async function doTicket(job) {
  const t = JSON.parse(fs.readFileSync(path.join(SIM_DIR, job.ref), "utf8"));
  const body = `# ${t.task} ${t.title}\n\n${t.description}`;
  await q(`INSERT INTO tickets (task, cr, rev, title, project, site, customer, region, state, priority, owner, created, required, last_edit, edit_no, capability, body_md, sha256, search)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, to_tsvector('english', $4 || ' ' || $17 || ' ' || $1))
           ON CONFLICT (task) DO UPDATE SET title=$4, project=$5, state=$9, priority=$10, owner=$11, required=$13, last_edit=$14, edit_no=$15, body_md=$17, sha256=$18,
             search=to_tsvector('english', $4 || ' ' || $17 || ' ' || $1)`,
    [t.task, t.cr, t.rev, t.title, t.project, t.site, t.customer, t.region, t.state, t.priority, t.owner, t.created, t.required, t.last_edit, t.edit_no, t.capability, body, sha256(JSON.stringify(t))]);
  await q("INSERT INTO ticket_versions (task, edit_no, snapshot) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [t.task, t.edit_no, JSON.stringify(t)]);
  await enqueue("L2", "card", t.task, t.task);
  // A ticket may arrive after code that names it: re-check those repos too.
  const repos = await q("SELECT DISTINCT repo FROM commits WHERE repo LIKE $1 OR message LIKE $2", [`%MYPM${t.cr}-%`, `%${t.task}%`]);
  for (const r of repos) await enqueue("L2", "repo", r.repo, null);
  const last = t.history[t.history.length - 1];
  return { summary: `Normalized ticket ${t.task} (edit #${t.edit_no}, ${t.state})`, edit_no: t.edit_no, state: t.state, chars: body.length, last_change: last.note };
}

async function doAttachment(job) {
  const full = path.join(SIM_DIR, job.ref);
  const name = path.basename(full);
  const buf = fs.readFileSync(full);
  let md, format;
  if (name.endsWith(".docx")) {
    format = "docx";
    md = (await mammoth.convertToMarkdown({ buffer: buf })).value;
  } else if (name.endsWith(".pdf")) {
    format = "pdf";
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    md = String(text).replace(/\s+\n/g, "\n").trim();
  } else {
    format = "md";
    md = buf.toString("utf8");
  }
  md = md.replace(/\\([.\-_()#])/g, "$1").trim();
  await q(`INSERT INTO documents (task, file_name, format, sha256, markdown, chars, search) VALUES ($1,$2,$3,$4,$5,$6, to_tsvector('english', $5))
           ON CONFLICT (task, file_name) DO UPDATE SET sha256=$4, markdown=$5, chars=$6, extracted_at=now(), search=to_tsvector('english', $5)`,
    [job.task, name, format, sha256(buf), md, md.length]);
  await enqueue("L2", "card", job.task, job.task);
  return { summary: `Extracted ${format.toUpperCase()} ${name} → ${md.length} chars of Markdown`, format, chars: md.length, preview: md.slice(0, 280) };
}

async function doCode(job) {
  const full = path.join(SIM_DIR, job.ref);
  const [, repo, ...rest] = job.ref.split("/");
  const file = rest.join("/");
  const src = fs.readFileSync(full, "utf8");
  const lang = file.endsWith(".py") ? "python" : "javascript";
  const units = lang === "python" ? parsePython(src) : parseJs(src);
  const sha = execFileSync("git", ["log", "-1", "--format=%H", "--", job.ref], { cwd: SIM_DIR, encoding: "utf8" }).trim();
  const names = [];
  for (const u of units) {
    const toks = codeTokens(u.body, lang);
    const norm = sha256(toks.join(" "));
    await q(`INSERT INTO code_units (repo, path, name, kind, lang, start_line, end_line, commit_sha, norm_hash, minhash, doc, body, search)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, to_tsvector('simple', regexp_replace($3 || ' ' || coalesce($11,'') || ' ' || $1, '[_A-Z]', ' \\&', 'g')))
             ON CONFLICT (repo, path, name) DO UPDATE SET kind=$4, start_line=$6, end_line=$7, commit_sha=$8, norm_hash=$9, minhash=$10, doc=$11, body=$12,
               search=to_tsvector('simple', regexp_replace($3 || ' ' || coalesce($11,'') || ' ' || $1, '[_A-Z]', ' \\&', 'g'))`,
      [repo, file, u.name, u.kind, lang, u.start, u.end, sha, norm, minhash(toks), u.doc, u.body]);
    names.push(`${u.name} L${u.start}-${u.end}`);
  }
  if (units.length) await q("DELETE FROM code_units WHERE repo=$1 AND path=$2 AND NOT (name = ANY($3))", [repo, file, units.map((u) => u.name)]);
  await enqueue("L2", "repo", repo, null);
  return { summary: `Parsed ${file} in ${repo}: ${units.length} unit(s)`, repo, lang, commit: sha.slice(0, 7), units: names };
}

export function parsePython(src) {
  const lines = src.split("\n");
  const units = [];
  let cur = null;
  const close = (endIdx) => {
    if (!cur) return;
    let e = endIdx;
    while (e > cur.startIdx && !lines[e].trim()) e--;
    const body = lines.slice(cur.startIdx, e + 1).join("\n");
    const dm = body.match(/"""([\s\S]*?)"""/);
    units.push({ name: cur.name, kind: cur.kind, start: cur.startIdx + 1, end: e + 1, body, doc: dm ? dm[1].trim() : null });
    cur = null;
  };
  lines.forEach((ln, i) => {
    const m = ln.match(/^(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (m) { close(i - 1); cur = { name: m[2], kind: m[1] === "def" ? "function" : "class", startIdx: i }; }
    else if (cur && ln.trim() && !/^\s/.test(ln)) close(i - 1);
  });
  close(lines.length - 1);
  return units;
}

export function parseJs(src) {
  const comments = [];
  const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script", locations: true, onComment: comments });
  const lines = src.split("\n");
  const units = [];
  for (const node of ast.body) {
    if (node.type !== "FunctionDeclaration" && node.type !== "ClassDeclaration") continue;
    const doc = comments.filter((c) => c.type === "Block" && c.loc.end.line === node.loc.start.line - 1).map((c) => c.value.replace(/^\*+|\*+$/g, "").trim())[0] || null;
    units.push({ name: node.id.name, kind: node.type === "ClassDeclaration" ? "class" : "function", start: node.loc.start.line, end: node.loc.end.line,
      body: lines.slice(node.loc.start.line - 1, node.loc.end.line).join("\n"), doc });
  }
  return units;
}
