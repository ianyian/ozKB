// Engineer portal API: Ask (agent with citations), capability pages, check-before-you-build,
// ticket package download, feedback, and code → requirement lookup.
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import JSZip from "jszip";
import { q, one } from "./db.js";
import { cfg, log } from "./ops.js";
import { tfidf, cosine } from "./text.js";
import { SIM_DIR } from "./sim/store.js";
import { SITES, CAPABILITIES, DUPLICATES } from "./sim/catalog.js";

export const portal = express.Router();
const h = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: e.message }); });
const CAP = Object.fromEntries([...CAPABILITIES, ...DUPLICATES].map((c) => [c.key, c]));
const capTitle = (k) => (CAP[k] ? CAP[k].title : String(k || "").replace(/_/g, " "));
const repoSite = (repo) => {
  const m = repo.match(/^([A-Z]+)-([A-Z]+)-/);
  return m ? SITES.filter((s) => s.region === m[1] && s.customer === m[2]).map((s) => s.site) : [];
};
const git = (args) => execFileSync("git", args, { cwd: SIM_DIR, encoding: "utf8", maxBuffer: 20e6, stdio: ["ignore", "pipe", "ignore"] });

// ---------------- home ----------------
portal.get("/api/home", h(async (req, res) => {
  const caps = await capabilitySummary();
  const recent = await q(`SELECT c.task, t.title, t.site, c.link_confidence, c.version, c.generated_at FROM cards c JOIN tickets t USING (task)
                          ORDER BY c.generated_at DESC LIMIT 6`);
  const counts = await one(`SELECT (SELECT count(*)::int FROM cards) cards, (SELECT count(DISTINCT site)::int FROM tickets) sites,
                              (SELECT count(*)::int FROM code_units) units, (SELECT count(DISTINCT capability)::int FROM tickets) capabilities`);
  const sites = await q("SELECT site, region, customer, count(*)::int n FROM tickets GROUP BY 1,2,3 ORDER BY 1");
  res.json({ counts, capabilities: caps, recent, sites });
}));

async function capabilitySummary() {
  const rows = await q(`SELECT capability k, count(*)::int tickets, count(DISTINCT site)::int sites, array_agg(DISTINCT site) site_list,
                          count(*) FILTER (WHERE c.link_confidence IN ('confirmed','strong'))::int linked
                        FROM tickets t LEFT JOIN cards c USING (task) GROUP BY capability ORDER BY sites DESC, tickets DESC`);
  return rows.map((r) => ({ ...r, title: capTitle(r.k), why: CAP[r.k] ? CAP[r.k].why : "" }));
}
portal.get("/api/capabilities", h(async (req, res) => res.json(await capabilitySummary())));

// ---------------- capability page ----------------
portal.get("/api/capability/:key", h(async (req, res) => {
  const key = req.params.key;
  const tickets = await q(`SELECT t.task, t.cr, t.rev, t.title, t.site, t.region, t.customer, t.state, t.created, c.link_confidence, c.overview
                           FROM tickets t LEFT JOIN cards c USING (task) WHERE t.capability=$1 ORDER BY t.site, t.task`, [key]);
  if (!tickets.length) return res.status(404).json({ error: `No tickets for ${key} yet.` });
  const copies = await q(`SELECT DISTINCT l.repo, l.task, l.commit_sha, l.evidence, l.source FROM links l JOIN tickets t USING (task)
                          WHERE t.capability=$1 AND l.status='active' AND l.tier IN ('inferred','strong') AND l.evidence LIKE '%copy of%'`, [key]);
  const separate = await q(`SELECT DISTINCT ON (o.cr) o.task, o.title, o.site, o.capability, s.score FROM similar_tickets s
                            JOIN tickets a ON a.task=s.task_a JOIN tickets o ON o.task=s.task_b
                            WHERE a.capability=$1 AND o.capability<>$1 AND s.score >= $2 ORDER BY o.cr, s.score DESC`, [key, cfg("similar.duplicate_threshold")]);
  const repos = await q(`SELECT DISTINCT l.repo FROM links l JOIN tickets t USING (task) WHERE t.capability=$1 AND l.status='active'`, [key]);
  const units = repos.length ? await q(`SELECT u.id, u.repo, u.path, u.name, m.group_id, m.role FROM code_units u LEFT JOIN clone_members m ON m.unit_id=u.id
                                        WHERE u.repo = ANY($1) ORDER BY u.repo, u.path, u.start_line`, [repos.map((r) => r.repo)]) : [];
  res.json({ key, title: capTitle(key), why: CAP[key] ? CAP[key].why : "", rule: CAP[key] ? CAP[key].rule : "", tickets,
    copies: copies.map((c) => ({ ...c, sites: repoSite(c.repo) })), separate, units });
}));

// ---------------- check before you build ----------------
portal.post("/api/check", h(async (req, res) => {
  const text = String(req.body.text || "").trim();
  if (text.length < 10) return res.status(400).json({ error: "Describe the requirement in a sentence or two." });
  const all = await q(`SELECT t.task, t.cr, t.title, t.site, t.state, t.capability, t.body_md, coalesce(string_agg(d.markdown, ' '), '') docs, max(c.link_confidence) conf
                       FROM tickets t LEFT JOIN documents d USING (task) LEFT JOIN cards c USING (task) GROUP BY t.task`);
  const vecs = tfidf([text, ...all.map((x) => `${x.title} ${x.body_md} ${x.docs}`)]);
  const scored = all.map((x, i) => ({ ...x, score: cosine(vecs[0], vecs[i + 1]) })).filter((x) => x.score > 0.12).sort((a, b) => b.score - a.score);
  const byCap = new Map();
  for (const x of scored) {
    if (!byCap.has(x.capability)) byCap.set(x.capability, { capability: x.capability, title: capTitle(x.capability), best: x.score, tickets: [], sites: new Set() });
    const g = byCap.get(x.capability);
    if (g.tickets.length < 4) g.tickets.push({ task: x.task, title: x.title, site: x.site, state: x.state, score: x.score, conf: x.conf });
    g.sites.add(x.site);
  }
  const groups = [...byCap.values()].slice(0, 5).map((g) => ({ ...g, sites: [...g.sites] }));
  await log("info", "API", `Check before you build: ${groups.length} similar function(s) for "${text.slice(0, 60)}"`);
  res.json({ groups, verdict: groups.length && groups[0].best >= 0.35 ? "exists" : groups.length && groups[0].best >= 0.2 ? "partial" : "new" });
}));

// ---------------- feedback ----------------
portal.post("/api/feedback", h(async (req, res) => {
  const { task, kind, note, question } = req.body || {};
  const labels = { up: "Helpful", down: "Not helpful", wrong_link: "Wrong link reported", outdated: "Outdated card reported" };
  if (!labels[kind]) return res.status(400).json({ error: "Unknown feedback kind" });
  const ref = `${task || "ask"}:${kind}:${Date.now()}`;
  if (kind !== "up") {
    await q(`INSERT INTO review_items (kind, ref, task, title, detail) VALUES ('feedback', $1, $2, $3, $4)`,
      [ref, task || null, `${labels[kind]}${task ? ` on ${task}` : ""}`, JSON.stringify({ note: note || "", question: question || null, evidence: note ? `Engineer note: ${note}` : null })]);
  }
  await log(kind === "up" ? "info" : "warn", "API", `Feedback: ${labels[kind]}${task ? ` on ${task}` : ""}${question ? ` for question "${question}"` : ""}`, { note }, { task });
  res.json({ ok: true, queued: kind !== "up" });
}));

// ---------------- ticket package ----------------
portal.get("/api/package/:task", h(async (req, res) => {
  const task = req.params.task;
  const t = await one("SELECT * FROM tickets WHERE task=$1", [task]);
  if (!t) return res.status(404).json({ error: "No such ticket" });
  const card = await one("SELECT card_md, version FROM cards WHERE task=$1", [task]);
  const links = await q("SELECT l.*, c.files, c.message FROM links l LEFT JOIN commits c ON c.sha=l.commit_sha WHERE l.task=$1 AND l.status='active'", [task]);
  const zip = new JSZip();
  const dir = path.join(SIM_DIR, "flexpm", t.cr, task);
  if (card) zip.file("knowledge-card.md", card.card_md);
  if (fs.existsSync(path.join(dir, "ticket.json"))) zip.file("flexpm/ticket.json", fs.readFileSync(path.join(dir, "ticket.json")));
  const attDir = path.join(dir, "attachments");
  if (fs.existsSync(attDir)) for (const f of fs.readdirSync(attDir)) zip.file(`attachments/${f}`, fs.readFileSync(path.join(attDir, f)));
  const refs = ["tier,repo,commit,file,evidence"];
  for (const l of links) {
    for (const f of l.files || []) {
      try { zip.file(`code/${l.repo}/${f}@${l.commit_sha.slice(0, 7)}`, git(["show", `${l.commit_sha}:repos/${l.repo}/${f}`])); } catch {}
      refs.push([l.tier, l.repo, l.commit_sha, f, JSON.stringify(l.evidence)].join(","));
    }
  }
  zip.file("references.csv", refs.join("\n"));
  zip.file("README.txt", `Ticket package ${task} – ${t.title}\nGenerated ${new Date().toISOString()} by KB Hub (prototype).\n\nknowledge-card.md   card v${card ? card.version : "-"} with source tags\nflexpm/ticket.json  ticket as exported from FlexPM, with edit history\nattachments/        original files\ncode/               linked code exactly as it was at each commit\nreferences.csv      links with confidence tier and evidence\n`);
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await log("info", "API", `Ticket package downloaded for ${task} (${(buf.length / 1024).toFixed(0)} KB)`, null, { task });
  res.set({ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${task}-package.zip"` }).send(buf);
}));

// ---------------- code → requirement ----------------
portal.get("/api/tree", h(async (req, res) => {
  const rows = await q("SELECT repo, array_agg(DISTINCT path) files FROM code_units GROUP BY repo ORDER BY repo");
  res.json(rows.map((r) => ({ ...r, sites: repoSite(r.repo) })));
}));
portal.get("/api/source", h(async (req, res) => {
  const { repo, path: file } = req.query;
  if (!/^[A-Za-z0-9._-]+$/.test(repo || "") || !/^[A-Za-z0-9._/-]+$/.test(file || "") || /\.\./.test(repo + "/" + file)) return res.status(400).json({ error: "Bad path" });
  const rel = `repos/${repo}/${file}`;
  let blame;
  try { blame = git(["blame", "--porcelain", "--", rel]); } catch { return res.status(404).json({ error: "File not found in the raw store" }); }
  const lines = [], commits = {};
  let cur = null;
  for (const ln of blame.split("\n")) {
    const m = ln.match(/^([0-9a-f]{40}) \d+ (\d+)/);
    if (m) { cur = m[1]; commits[cur] = commits[cur] || {}; continue; }
    if (ln.startsWith("author ")) commits[cur].author = ln.slice(7);
    else if (ln.startsWith("author-time ")) commits[cur].date = new Date(Number(ln.slice(12)) * 1000).toISOString();
    else if (ln.startsWith("summary ")) commits[cur].message = ln.slice(8);
    else if (ln.startsWith("\t")) lines.push({ n: lines.length + 1, text: ln.slice(1), sha: cur });
  }
  for (const sha of Object.keys(commits)) {
    commits[sha].links = await q("SELECT l.task, l.tier, l.source, l.evidence, t.title FROM links l JOIN tickets t USING (task) WHERE l.commit_sha=$1 AND l.status='active' ORDER BY CASE l.tier WHEN 'confirmed' THEN 0 WHEN 'strong' THEN 1 ELSE 2 END", [sha]);
  }
  const units = await q(`SELECT u.id, u.name, u.start_line, u.end_line, m.group_id, m.role,
                           (SELECT json_agg(json_build_object('repo', u2.repo, 'path', u2.path, 'role', m2.role)) FROM clone_members m2 JOIN code_units u2 ON u2.id=m2.unit_id
                             WHERE m2.group_id=m.group_id AND u2.id<>u.id) AS others
                         FROM code_units u LEFT JOIN clone_members m ON m.unit_id=u.id WHERE u.repo=$1 AND u.path=$2 ORDER BY u.start_line`, [repo, file]);
  res.json({ repo, path: file, sites: repoSite(repo), lines, commits, units });
}));

// ---------------- Ask ----------------
const QWORDS = new Set("which what where when who why how many much does do did is are was were the a an of for to in at on and or have has had there any our we us site sites plant plants else built build implemented implement implementation function functions feature code repo exist exists existing use using used it its this that from with by about can could should would me tell explain show list all".split(" "));

portal.post("/api/ask", h(async (req, res) => {
  const question = String(req.body.q || "").trim();
  if (!question) return res.status(400).json({ error: "Type a question." });
  const steps = [];
  const step = async (tool, input, fn) => { const t0 = Date.now(); const out = await fn(); steps.push({ tool, input, output: out.summary, ms: Date.now() - t0 }); return out; };
  const sources = [];
  const cite = (s) => { let i = sources.findIndex((x) => x.key === s.key); if (i < 0) { sources.push(s); i = sources.length - 1; } return `[${i + 1}]`; };

  // A ticket or CR number anywhere in the question pins the answer to that ticket:
  // "may i know 128605-01 do?", "what is CR 128605", "FLEXPM128605-01".
  const idm = question.match(/(?:FLEXPM|CR)?\s*#?(?<!\d)(\d{6})(?:-(\d{2}))?(?!\d)/i);
  const listQ = /\b(which|what|how many|list|where)\b[\s\S]*\b(sites?|plants?|where|else)\b/i.test(question);
  const codeQ = /\b(code|function|implemented|implementation|repo|source)\b/i.test(question) && !/\bwhy\b/i.test(question);
  const type = idm ? (listQ ? "list" : codeQ ? "code" : "ticket") : listQ ? "list" : codeQ ? "code" : "explain";
  steps.push({ tool: "classify", input: question, output: `question type: ${type}${idm ? `, about ${idm[1]}${idm[2] ? "-" + idm[2] : ""}` : ""}`, ms: 0 });

  const terms = question.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !QWORDS.has(w) && !/^\d+$/.test(w));
  let md = "", task = null, capability = null;

  if (idm) {
    const t = await step("query_links", idm[0].trim(), async () => {
      const r = idm[2] ? await one("SELECT task, cr, capability, title FROM tickets WHERE task=$1", [`${idm[1]}-${idm[2]}`])
                       : await one("SELECT task, cr, capability, title FROM tickets WHERE cr=$1 ORDER BY rev LIMIT 1", [idm[1]]);
      return { ...(r || {}), summary: r ? `found ${r.task} ${r.title}` : "no such ticket" };
    });
    if (!t.task) md = `I could not find ${idm[0].trim()} in the knowledge base. It may not have been loaded yet; check the ticket number or try **Search**.`;
    else {
      task = t.task; capability = t.capability;
      if (type === "list") md = await answerList(capability, step, cite);
      else md = await answerExplain(task, capability, step, cite, { ticket: true, codeOnly: type === "code" });
    }
  } else {
    // Find the capability the question is about.
    const hit = await step("search_kb", terms.join(" "), async () => {
      if (!terms.length) return { summary: "no search terms" };
      const tsq = terms.map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean).join(" | ");
      const words = tsq.split(" | ");
      // Most of the question's words must appear in the card, so off-topic questions find nothing.
      const need = Math.max(1, Math.ceil(words.length * 0.6));
      const r = await q(`SELECT * FROM (
                           SELECT c.task, t.capability, t.title, t.cr, ts_rank(c.search, to_tsquery('english', $1)) rank,
                                  (SELECT count(*)::int FROM unnest($2::text[]) w WHERE c.search @@ to_tsquery('english', w)) hits
                           FROM cards c JOIN tickets t USING (task) WHERE c.search @@ to_tsquery('english', $1)) x
                         WHERE hits >= $3 ORDER BY hits DESC, rank DESC, task LIMIT 5`, [tsq, words, need]);
      return { rows: r, summary: r.length ? `top: ${r.slice(0, 3).map((x) => `${x.task} (${x.hits}/${words.length} words)`).join(", ")}` : `no card matches ${need} of ${words.length} words` };
    });
    if (!hit.rows || !hit.rows.length) {
      md = `I found nothing in the knowledge base about "${question}". Try other words, a ticket number such as 118256-01, or check whether the function exists under a different name with **Check before you build**.`;
    } else {
      capability = hit.rows[0].capability;
      task = hit.rows[0].task;
      if (type === "list") md = await answerList(capability, step, cite);
      else if (type === "code") md = await answerCode(capability, step, cite);
      else {
        // Explain from the family's first revision: it holds the original requirement and reason.
        const first = await one("SELECT task FROM tickets WHERE cr=$1 ORDER BY rev LIMIT 1", [hit.rows[0].cr]);
        md = await answerExplain(first ? first.task : hit.rows[0].task, capability, step, cite);
      }
    }
  }

  let mode = "grounded";
  if (cfg("llm.provider") === "hf" && process.env.HF_TOKEN && sources.length) {
    try {
      const t0 = Date.now();
      md = await llmRewrite(question, md);
      mode = cfg("llm.model");
      steps.push({ tool: "llm", input: cfg("llm.model"), output: "rewrote the grounded answer, citations kept", ms: Date.now() - t0 });
    } catch (e) { steps.push({ tool: "llm", input: cfg("llm.model"), output: `failed (${e.message.slice(0, 80)}), kept grounded answer`, ms: 0 }); }
  }
  await log("info", "API", `Ask (${type}): "${question}" → ${sources.length} source(s), ${mode}`, { steps: steps.map((s) => s.tool) }, { task });
  res.json({ question, type, answer: md, sources, steps, mode, capability, capability_title: capability ? capTitle(capability) : null, task });
}));

async function answerList(capability, step, cite) {
  const rows = await step("which_sites", capability, async () => {
    const r = await q(`SELECT t.site, t.task, t.title, t.state, c.link_confidence FROM tickets t LEFT JOIN cards c USING (task)
                       WHERE t.capability=$1 ORDER BY t.site, t.task`, [capability]);
    return { rows: r, summary: `${new Set(r.map((x) => x.site)).size} site(s), ${r.length} ticket(s) from the link DB` };
  });
  const copies = await step("query_links", `${capability} copies`, async () => {
    const r = await q(`SELECT DISTINCT l.repo, l.commit_sha, l.source, t.task FROM links l JOIN tickets t USING (task)
                       WHERE t.capability=$1 AND l.status='active' AND l.evidence LIKE '%copy of%'`, [capability]);
    return { rows: r, summary: `${r.length} plug-and-play cop${r.length === 1 ? "y" : "ies"} found by code similarity` };
  });
  const sep = await step("find_similar", capability, async () => {
    const r = await q(`SELECT DISTINCT ON (o.cr) o.task, o.title, o.site, s.score FROM similar_tickets s JOIN tickets a ON a.task=s.task_a JOIN tickets o ON o.task=s.task_b
                       WHERE a.capability=$1 AND o.capability<>$1 AND s.score >= $2 ORDER BY o.cr, s.score DESC`, [capability, cfg("similar.duplicate_threshold")]);
    return { rows: r, summary: `${r.length} similar function(s) built separately` };
  });
  const bySite = new Map();
  for (const r of rows.rows) { if (!bySite.has(r.site)) bySite.set(r.site, []); bySite.get(r.site).push(r); }
  const copySites = new Set(copies.rows.flatMap((c) => repoSite(c.repo)).filter((s) => !bySite.has(s)));
  let md = `**${capTitle(capability)}** is at **${bySite.size + copySites.size} site(s)**${copySites.size ? ` (${copySites.size} only as a copy without a CR)` : ""}:\n\n`;
  for (const [site, list] of bySite) {
    md += `- **${site}**: ${list.map((r) => `${r.task} ${r.state.toLowerCase()} ${cite({ key: `T:${r.task}`, label: `${r.task} ${r.title}`, href: `#/ticket/${r.task}` })}`).join(", ")} · ${best(list) === "unlinked" || best(list) === "none" ? "no code linked yet" : `code link ${best(list)}`}\n`;
  }
  for (const c of copies.rows) {
    const sites = repoSite(c.repo).join("/");
    md += `- **${sites}**${repoSite(c.repo).some((x) => bySite.has(x)) ? " also has" : ":"} a copy of ${c.task} in ${c.repo}, no CR of its own · *${c.source === "expert" ? "confirmed by an expert" : "inferred from code similarity"}* ${cite({ key: `R:${c.repo}`, label: `${c.repo} @${c.commit_sha.slice(0, 7)}`, href: `#/code?repo=${encodeURIComponent(c.repo)}` })}\n`;
  }
  if (sep.rows.length) {
    md += `\nAlso built separately (similar requirement, different code):\n`;
    for (const s of sep.rows) md += `- **${s.site}**: ${s.task} ${s.title} (similarity ${Number(s.score).toFixed(2)}) ${cite({ key: `T:${s.task}`, label: `${s.task} ${s.title}`, href: `#/ticket/${s.task}` })}\n`;
  }
  const cov = await one("SELECT count(*)::int total, count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.commit_sha=c.sha AND l.status='active'))::int unlinked FROM commits c");
  md += `\n*Completeness: listed from the link database. ${cov.unlinked} of ${cov.total} commits are not linked to any CR yet, so a site could be missing if its copy is unlinked.*`;
  return md;
}

async function answerExplain(task, capability, step, cite, opts = {}) {
  const card = await step("get_card", task, async () => {
    const r = await one(`SELECT c.card_md, c.link_confidence, t.title, t.site, t.customer, t.state, t.cr, t.rev FROM tickets t LEFT JOIN cards c USING (task) WHERE t.task=$1`, [task]);
    return { ...(r || {}), summary: r && r.card_md ? `read card ${task}` : `no card for ${task} yet` };
  });
  const tcite = cite({ key: `T:${task}`, label: `${task} ${card.title}`, href: `#/ticket/${task}` });
  if (!card.card_md) return `**${task} ${card.title}** (${card.site}, ${card.state}) ${tcite}\n\nL2 has not written a knowledge card for this ticket yet.`;
  const refs = parseRefs(card.card_md);
  const conv = (text) => text.replace(/\[((?:T|A|C)\d+)(?:[^\]]*)\]/g, (_, tag) => {
    const r = refs[tag]; if (!r) return "";
    return cite({ key: `${task}:${tag}`, label: r, href: tag.startsWith("C") ? `#/ticket/${task}?tab=code` : `#/ticket/${task}?tab=sources` });
  });
  const overview = section(card.card_md, "# Overview");
  const business = section(card.card_md, "## Business logic");
  const technical = section(card.card_md, "## Technical logic");
  const family = await step("get_index", `CR family ${card.cr}`, async () => {
    const r = await q("SELECT task, title FROM tickets WHERE cr=$1 ORDER BY rev", [card.cr]);
    return { rows: r, summary: `${r.length} revision(s) in family ${card.cr}` };
  });
  if (opts.codeOnly) {
    const links = await step("query_links", task, async () => {
      const r = await q("SELECT repo, commit_sha, tier, evidence FROM links WHERE task=$1 AND status='active' ORDER BY tier", [task]);
      return { rows: r, summary: `${r.length} linked commit(s)` };
    });
    return `Code for **${task} ${card.title}**, as it was at the linked commit${links.rows.length > 1 ? "s" : ""} ${tcite}:\n\n${conv(technical)}\n\n**How it is linked:**\n${links.rows.map((l) => `- ${l.tier}: ${l.repo} @${(l.commit_sha || "").slice(0, 7)} – ${l.evidence}`).join("\n") || "- No code linked."}`;
  }
  let md = opts.ticket
    ? `**${task} ${card.title}** · ${card.site} (${card.customer}) · ${card.state.toLowerCase()} · code link ${card.link_confidence} ${tcite}\n\n**What it does:** ${conv(overview)}\n\n**The rules:**\n${conv(business)}\n`
    : `${conv(overview)}\n\n**The rules:**\n${conv(business)}\n`;
  if (opts.ticket) md += `\n**The code (as it was for this revision):**\n${conv(technical)}\n`;
  if (family.rows.length > 1) {
    md += `\n**${opts.ticket ? "Revisions" : "How it evolved"}:**\n${family.rows.map((f) => `- ${f.task === task ? `**${f.task}**` : f.task}: ${f.title.replace(/^[^:]+:\s*/, "")} ${cite({ key: `T:${f.task}`, label: `${f.task} ${f.title}`, href: `#/ticket/${f.task}` })}`).join("\n")}\n`;
  }
  if (opts.ticket) {
    const others = await step("which_sites", capability, async () => {
      const r = await q("SELECT site, string_agg(task, ', ' ORDER BY task) tasks FROM tickets WHERE capability=$1 AND cr<>$2 GROUP BY site ORDER BY site", [capability, card.cr]);
      return { rows: r, summary: `${r.length} other site(s) with ${capability}` };
    });
    if (others.rows.length) md += `\n**Same function at other sites:** ${others.rows.map((o) => `${o.site} (${o.tasks})`).join(", ")}. Ask *"Which sites have ${capTitle(capability).toLowerCase()}?"* for the complete list.`;
  } else {
    md += `\nOther sites with this function: ask *"Which sites have ${capTitle(capability).toLowerCase()}?"*`;
  }
  return md;
}

async function answerCode(capability, step, cite) {
  const units = await step("search_code", capability, async () => {
    const r = await q(`SELECT DISTINCT ON (coalesce(m.group_id, -u.id)) u.id, u.repo, u.path, u.name, u.start_line, u.end_line, u.doc, m.group_id,
                         (SELECT count(*)::int - 1 FROM clone_members m2 WHERE m2.group_id=m.group_id) copies
                       FROM code_units u LEFT JOIN clone_members m ON m.unit_id=u.id
                       WHERE EXISTS (SELECT 1 FROM links l JOIN tickets t USING (task) JOIN commits c ON c.sha=l.commit_sha
                                     WHERE t.capability=$1 AND l.status='active' AND l.repo=u.repo AND u.path = ANY(c.files))
                       ORDER BY coalesce(m.group_id, -u.id), m.role='origin' DESC LIMIT 12`, [capability]);
    return { rows: r, summary: `${r.length} function(s), copies collapsed` };
  });
  let md = `Code for **${capTitle(capability)}** (copies collapsed into one line each):\n\n`;
  for (const u of units.rows) {
    md += `- \`${u.name}\` in ${u.repo}/${u.path} L${u.start_line}-${u.end_line}${u.copies > 0 ? ` (+${u.copies} cop${u.copies > 1 ? "ies" : "y"})` : ""}${u.doc ? `: ${u.doc}` : ""} ${cite({ key: `U:${u.id}`, label: `${u.repo}/${u.path} ${u.name}`, href: `#/code?repo=${encodeURIComponent(u.repo)}&path=${encodeURIComponent(u.path)}&line=${u.start_line}` })}\n`;
  }
  return md;
}

const best = (list) => { const o = ["confirmed", "strong", "inferred", "unlinked"]; return o.find((t) => list.some((r) => r.link_confidence === t)) || "none"; };
const stripTags = (s) => String(s).replace(/\s*\[(?:T|A|C)\d+\]/g, "");
function section(md, head) {
  const i = md.indexOf(head + "\n"); if (i < 0) return "";
  const rest = md.slice(i + head.length + 1);
  const j = rest.search(/\n## /);
  return (j < 0 ? rest : rest.slice(0, j)).trim();
}
function parseRefs(md) {
  const out = {};
  for (const m of section(md, "## References").matchAll(/^- \[((?:T|A|C)\d+)\] (.+)$/gm)) out[m[1]] = m[2];
  return out;
}

async function llmRewrite(question, grounded) {
  const res = await fetch("https://router.huggingface.co/v1/chat/completions", {
    method: "POST", headers: { Authorization: `Bearer ${process.env.HF_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg("llm.model"), max_tokens: 700, temperature: 0.2, messages: [{ role: "user", content:
      `Rewrite this answer to the engineer's question in clear, short English. Use ONLY the facts below. Keep every citation marker like [1] next to the fact it supports. Keep the markdown.\n\nQuestion: ${question}\n\nFacts:\n${grounded}` }] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return j.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}
