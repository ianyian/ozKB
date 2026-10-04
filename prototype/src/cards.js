// Knowledge card writer. One card per task revision: front-matter, overview, business and
// technical logic, variants, history, gaps and references. Every statement carries a source tag:
// [T1] ticket, [A#] attachment, [C#] code. The built-in writer is rule-based (no model cost);
// provider "hf" asks an open-weight model on Hugging Face to write the Overview and Business logic.
import { execFileSync } from "node:child_process";
import { q, one } from "./db.js";
import { cfg, log } from "./ops.js";
import { SIM_DIR } from "./sim/store.js";
import { parsePython, parseJs } from "./l1.js";
import { tagText } from "./tags.js";

const TIER_ORDER = ["confirmed", "strong", "inferred"];

async function unitsAtCommits(links) {
  const byKey = new Map();
  const commits = links.filter((l) => l.commit_sha).sort((a, b) => new Date(a.committed_at) - new Date(b.committed_at));
  for (const l of commits) {
    const c = await one("SELECT files FROM commits WHERE sha=$1", [l.commit_sha]);
    for (const file of (c && c.files) || []) {
      if (!/\.(py|js)$/.test(file)) continue;
      let src;
      try { src = execFileSync("git", ["show", `${l.commit_sha}:repos/${l.repo}/${file}`], { cwd: SIM_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { continue; }
      const lang = file.endsWith(".py") ? "python" : "javascript";
      for (const u of lang === "python" ? parsePython(src) : parseJs(src)) {
        byKey.set(`${l.repo}/${file}/${u.name}`, { repo: l.repo, path: file, name: u.name, kind: u.kind, lang, start_line: u.start, end_line: u.end, commit_sha: l.commit_sha, doc: u.doc, body: u.body });
      }
    }
  }
  return [...byKey.values()];
}

export async function writeCard(t, sims, ctx) {
  const docs = await q("SELECT file_name, format, markdown FROM documents WHERE task=$1 ORDER BY file_name", [t.task]);
  const links = await q("SELECT l.*, c.message, c.committed_at, c.author FROM links l LEFT JOIN commits c ON c.sha=l.commit_sha WHERE l.task=$1 AND l.status='active' ORDER BY c.committed_at", [t.task]);
  const repos = [...new Set(links.map((l) => l.repo))];
  // Code AS IT WAS at the linked commits (git show <sha>:<file>), not today's version of the repo.
  // Inferred code goes under "Variants & reuse" unless it is the only code this ticket has.
  const solid = links.filter((l) => l.tier !== "inferred");
  const units = await unitsAtCommits(solid.length ? solid : links);
  const inferredElsewhere = solid.length ? links.filter((l) => l.tier === "inferred") : [];
  const current = units.length ? await q("SELECT id, repo, path, name FROM code_units WHERE repo = ANY($1)", [repos]) : [];
  for (const u of units) u.id = (current.find((c) => c.repo === u.repo && c.path === u.path && c.name === u.name) || {}).id;
  const family = await q("SELECT task, title, state FROM tickets WHERE cr=$1 ORDER BY rev", [t.cr]);
  const versions = await q("SELECT edit_no, snapshot->'history' AS history FROM ticket_versions WHERE task=$1 ORDER BY edit_no DESC LIMIT 1", [t.task]);
  const clones = units.length ? await q(`
      SELECT DISTINCT g.id, g.label, u2.repo, u2.path, u2.name, cm2.role, cm2.similarity
        FROM clone_members cm JOIN clone_groups g ON g.id=cm.group_id
        JOIN clone_members cm2 ON cm2.group_id=g.id JOIN code_units u2 ON u2.id=cm2.unit_id
       WHERE cm.unit_id = ANY($1) AND u2.repo <> ALL($2) ORDER BY g.id`, [units.map((u) => u.id).filter(Boolean), repos]) : [];

  const best = TIER_ORDER.find((tier) => links.some((l) => l.tier === tier)) || "unlinked";
  const A = docs.map((d, i) => ({ ...d, tag: `A${i + 1}` }));
  const C = units.map((u, i) => ({ ...u, tag: `C${i + 1}` }));
  const spec = A.find((d) => /spec_rev/.test(d.file_name) && /revB/.test(d.file_name)) || A.find((d) => /spec_rev/.test(d.file_name));
  const reqLines = spec ? spec.markdown.split("\n").filter((l) => /^\s*[-*]\s|:\s*\d/.test(l)).map((l) => l.replace(/^\s*[-*]\s*/, "").trim()).slice(0, 8) : [];
  const background = (spec && sectionText(spec.markdown, "Background")) || sectionText(t.body_md, "Background");
  const requirement = (spec && sectionText(spec.markdown, "Requirement")) || sectionText(t.body_md, "Requirement");
  const prev = family.filter((f) => f.task < t.task).pop();
  const next = family.find((f) => f.task > t.task);

  let overview = `${t.title}. ${firstSentence(requirement)} [T1]${spec ? `[${spec.tag}]` : ""}`;
  if (background) overview += ` Built because ${lowerFirst(firstSentence(background))}${spec ? ` [${spec.tag}]` : " [T1]"}`;
  overview += ` Runs for ${t.site} (${t.customer}), project ${t.project}. [T1]`;
  let business = [requirement ? `${requirement.split("\n")[0]} [T1]` : null, ...reqLines.map((l) => `- ${l} [${spec.tag}]`)].filter(Boolean).join("\n");
  let model = "builtin-writer";
  let tokensIn = 0, tokensOut = 0;

  if (cfg("llm.provider") === "hf" && process.env.HF_TOKEN) {
    try {
      const r = await llmSections(t, docs, units, best);
      overview = r.overview; business = r.business; model = cfg("llm.model"); tokensIn = r.tokensIn; tokensOut = r.tokensOut;
    } catch (e) {
      await log("warn", "L2", `Model call failed, used built-in writer: ${e.message}`, null, ctx);
    }
  }

  const technical = C.length
    ? C.map((u) => `- \`${u.name}\` (${u.lang} ${u.kind}) in ${u.repo}/${u.path} L${u.start_line}-${u.end_line}${u.doc ? `: ${firstSentence(u.doc)}` : ""} [${u.tag}]`).join("\n") + constantsLine(C)
    : "No linked code yet.";
  const variants = [
    prev ? `- Previous revision: ${prev.task} (${prev.title})` : null,
    next ? `- Next revision: ${next.task} (${next.title})` : null,
    ...inferredElsewhere.map((l) => `- INFERRED reuse in ${l.repo} @${(l.commit_sha || "").slice(0, 7)}: ${l.evidence}`),
    ...groupClones(clones).map((g) => `- Clone group CG-${String(g.id).padStart(4, "0")} (${g.label}): ${g.members.join("; ")}`),
    ...sims.slice(0, 3).map((s) => `- Similar requirement: ${s.task} at ${s.site} (${s.score.toFixed(2)}) – ${s.title}`),
  ].filter(Boolean).join("\n") || "None found.";
  const hist = (versions[0] && versions[0].history) || [];
  const history = [
    ...hist.slice(-6).map((h) => `- Edit #${h.edit_no} ${String(h.at).slice(0, 10)}: ${h.note}${h.changes && h.changes.length ? ` (${h.changes.join("; ")})` : ""} [T1]`),
    ...links.filter((l) => l.commit_sha).map((l) => `- Commit ${l.commit_sha.slice(0, 7)} ${String(l.committed_at ? new Date(l.committed_at).toISOString() : "").slice(0, 10)} by ${l.author}: "${l.message}" (${l.tier})`),
  ].join("\n");
  const gaps = [
    !links.length ? "- No code is linked to this ticket. The code may be missing, unlinked, or not built yet." : null,
    links.some((l) => l.tier === "inferred") ? "- Some links are INFERRED (not stated in MyPM or commits). Verify before relying on them." : null,
    !spec ? "- No specification document attached." : null,
    /NOT IMPLEMENTED/.test(t.state) ? "- Ticket state is NOT IMPLEMENTED." : null,
  ].filter(Boolean).join("\n") || "- None detected.";
  const refs = [
    `[T1] MyPM ${t.task}, edit #${t.edit_no} (${String(t.last_edit ? new Date(t.last_edit).toISOString() : "").slice(0, 10)})`,
    ...A.map((d) => `[${d.tag}] ${d.file_name} (${d.format})`),
    ...C.map((u) => `[${u.tag}] ${u.repo}/${u.path} L${u.start_line}-${u.end_line} @${(u.commit_sha || "").slice(0, 7)}`),
  ].map((r) => `- ${r}`).join("\n");

  // Function tags from a controlled vocabulary, with the words that triggered them as evidence.
  const tagSource = [t.title, t.body_md, ...docs.map((d) => d.markdown), ...units.map((u) => `${u.name} ${u.doc || ""}`)].join("\n");
  const tags = tagText(tagSource, t.title);
  const fm = [
    "---", `ticket: ${t.task}`, `cr_family: ${t.cr}`, `revision: ${String(t.rev).padStart(2, "0")}`, `title: ${t.title}`, `project: ${t.project}`,
    `site: ${t.site}`, `customer: ${t.customer}`, `region: ${t.region}`, `state: ${t.state}`, `owner: ${t.owner}`,
    `previous_revision: ${prev ? prev.task : ""}`, `repos: [${repos.join(", ")}]`, `commits: [${links.map((l) => (l.commit_sha || "").slice(0, 7)).filter(Boolean).join(", ")}]`,
    `tags: [${tags.map((x) => x.tag).join(", ")}]`, `link_confidence: ${best}`, `template_version: ${cfg("card.template_version")}`, `model: ${model}`, "---",
  ].join("\n");
  const md = `${fm}\n\n# Overview\n${overview}\n\n## Business logic\n${business || "Not stated in the sources."}\n\n## Technical logic\n${technical}\n\n## Variants & reuse\n${variants}\n\n## Change history\n${history}\n\n## Gaps & confidence\n${gaps}\n\n## References\n${refs}\n`;

  await q("DELETE FROM card_tags WHERE task=$1 AND source<>'expert'", [t.task]);
  for (const x of tags) await q("INSERT INTO card_tags (task, tag, source, evidence) VALUES ($1,$2,'rule',$3) ON CONFLICT DO NOTHING", [t.task, x.tag, x.evidence.join(", ")]);
  const cur = await one("SELECT version, card_md, status FROM cards WHERE task=$1", [t.task]);
  if (cur && cur.card_md === md) return { unchanged: true, version: cur.version };
  const version = cur ? cur.version + 1 : 1;
  const searchText = `${t.task} ${t.title} ${overview} ${business} ${technical} ${t.site} ${t.customer} ${tags.map((x) => x.tag).join(" ")}`;
  await q(`INSERT INTO cards (task, version, template_version, card_md, overview, link_confidence, status, model, tokens_in, tokens_out, generated_at, search)
           VALUES ($1,$2,$3,$4,$5,$6,'generated',$7,$8,$9, now(), to_tsvector('english', $10))
           ON CONFLICT (task) DO UPDATE SET version=$2, template_version=$3, card_md=$4, overview=$5, link_confidence=$6,
             status = CASE WHEN cards.status='reviewed' THEN 'reviewed · source changed' ELSE 'generated' END,
             model=$7, tokens_in=$8, tokens_out=$9, generated_at=now(), search=to_tsvector('english', $10)`,
    [t.task, version, cfg("card.template_version"), md, overview, best, model, tokensIn, tokensOut, searchText]);
  await q("INSERT INTO card_history (task, version, card_md, model, generated_at) VALUES ($1,$2,$3,$4, now()) ON CONFLICT DO NOTHING", [t.task, version, md, model]);
  return { version, linkConfidence: best, model, sections: 7 };
}

function sectionText(md, heading) {
  const m = String(md || "").match(new RegExp(`(?:^|\\n)#*\\s*\\d*\\s*${heading}\\s*\\n+([\\s\\S]*?)(?=\\n#*\\s*\\d*\\s*[A-Z][a-z]+(?: [a-z]+)*\\s*\\n|$)`));
  return m ? m[1].trim() : "";
}
const firstSentence = (s) => { const x = String(s || "").split("\n")[0].trim(); const m = x.match(/^.*?[.!?](\s|$)/); return (m ? m[0] : x).trim().replace(/([^.])$/, "$1."); };
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
function constantsLine(C) {
  const consts = new Set();
  for (const u of C) for (const m of u.body.matchAll(/\b([A-Z][A-Z_]{3,})\b/g)) consts.add(m[1]);
  return consts.size ? `\n- Configuration constants referenced: ${[...consts].slice(0, 6).join(", ")}` : "";
}
function groupClones(rows) {
  const g = new Map();
  for (const r of rows) {
    if (!g.has(r.id)) g.set(r.id, { id: r.id, label: r.label, members: [] });
    g.get(r.id).members.push(`${r.repo}/${r.path} (${r.role}${r.role === "variant" ? ` ${Number(r.similarity).toFixed(2)}` : ""})`);
  }
  return [...g.values()];
}

async function llmSections(t, docs, units, best) {
  const prompt = `You write knowledge cards for a manufacturing execution system. Use ONLY the sources below. Tag every sentence with its source: [T1] for the ticket, [A1].. for attachments in the order given, [C1].. for code units in the order given.
Return exactly two sections:
OVERVIEW: 3 sentences on what it does, why it was built, where it runs.
BUSINESS: bullet list of the business rules with limits.

[T1] TICKET ${t.task}
${t.body_md}

${docs.map((d, i) => `[A${i + 1}] ${d.file_name}\n${d.markdown.slice(0, 2500)}`).join("\n\n")}

${units.slice(0, 6).map((u, i) => `[C${i + 1}] ${u.repo}/${u.path} ${u.name}\n${u.body.slice(0, 800)}`).join("\n\n")}`;
  const res = await fetch("https://router.huggingface.co/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.HF_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg("llm.model"), messages: [{ role: "user", content: prompt }], max_tokens: 600, temperature: 0.2 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  const text = j.choices[0].message.content.replace(/<think>[\s\S]*?<\/think>/g, "");
  const ov = (text.match(/OVERVIEW:\s*([\s\S]*?)(?=BUSINESS:|$)/) || [])[1];
  const bu = (text.match(/BUSINESS:\s*([\s\S]*)$/) || [])[1];
  if (!ov || !bu) throw new Error("model answer did not follow the format");
  return { overview: ov.trim(), business: bu.trim(), tokensIn: j.usage?.prompt_tokens || 0, tokensOut: j.usage?.completion_tokens || 0 };
}
