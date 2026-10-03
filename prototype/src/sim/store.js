// Applies simulator events to the raw store (sim-data/): FlexPM ticket exports with
// attachments, plus source repos as sub-folders of one git repository with real commits.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";
import PDFDocument from "pdfkit";
import { ROOT } from "../db.js";
import { CAPABILITIES, DUPLICATES } from "./catalog.js";

export const SIM_DIR = process.env.SIM_DIR || path.join(ROOT, "sim-data");
const CAPS = Object.fromEntries([...CAPABILITIES, ...DUPLICATES].map((c) => [c.key, c]));

function git(args, env = {}) {
  return execFileSync("git", args, { cwd: SIM_DIR, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function resetStore() {
  fs.rmSync(SIM_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(SIM_DIR, "flexpm"), { recursive: true });
  fs.mkdirSync(path.join(SIM_DIR, "repos"), { recursive: true });
  // FlexPM is not a git system: its exports sit next to the repos but outside git history.
  // That also keeps commit ids identical when the store is rebuilt by replay after a restart.
  fs.writeFileSync(path.join(SIM_DIR, ".gitignore"), "flexpm/\n");
  fs.writeFileSync(path.join(SIM_DIR, "README.md"), "# Simulated raw store\n\n- `flexpm/` – FlexPM ticket exports (one folder per task revision)\n- `repos/` – source repositories (one sub-folder per repo)\n");
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "FlexPM Export"]);
  git(["config", "user.email", "flexpm-export@example.com"]);
  commitAll("Initialize raw store", { name: "FlexPM Export", email: "flexpm-export@example.com" }, "2019-01-01T00:00:00Z");
}

export function storeReady() {
  return fs.existsSync(path.join(SIM_DIR, ".git"));
}

function commitAll(message, who, atIso) {
  git(["add", "-A"]);
  const env = { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email, GIT_AUTHOR_DATE: atIso, GIT_COMMITTER_DATE: atIso };
  try { git(["commit", "-q", "--allow-empty", "-m", message], env); } catch (e) { /* nothing to commit */ }
  return git(["rev-parse", "HEAD"]);
}

const ticketDir = (task) => path.join(SIM_DIR, "flexpm", task.split("-")[0], task);

export async function applyEvent(ev) {
  if (ev.type === "ticket_new") {
    const t = ev.ticket;
    const dir = ticketDir(t.task);
    fs.mkdirSync(path.join(dir, "attachments"), { recursive: true });
    const record = { ...t, edit_no: 1, last_edit: ev.atIso, history: [{ edit_no: 1, at: ev.atIso, note: "Created" }] };
    delete record.attachments;
    record.attachments = [];
    for (const a of t.attachments) {
      await writeAttachment(dir, t, a);
      record.attachments.push(a.name);
    }
    fs.writeFileSync(path.join(dir, "ticket.json"), JSON.stringify(record, null, 2));
    return { summary: `New ${t.rev === 1 ? "CR" : "revision"} ${t.task}: ${t.title}`, task: t.task };
  }
  if (ev.type === "ticket_edit") {
    const dir = ticketDir(ev.task);
    const file = path.join(dir, "ticket.json");
    if (!fs.existsSync(file)) return { summary: `Skipped edit of unknown ${ev.task}`, task: ev.task };
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    const changed = [];
    for (const [k, v] of Object.entries(ev.changes)) {
      if (k === "spec_rev") continue;
      if (rec[k] !== v) { changed.push(`${k}: ${rec[k] || "—"} → ${v}`); rec[k] = v; }
    }
    if (ev.changes.spec_rev) {
      const name = `${ev.task}_spec_rev${ev.changes.spec_rev}.docx`;
      await writeAttachment(dir, rec, { name, kind: "spec", rev: ev.changes.spec_rev });
      if (!rec.attachments.includes(name)) rec.attachments.push(name);
      changed.push(`attachment added: ${name}`);
      rec.description += `\n\nUpdate (rev ${ev.changes.spec_rev}): customer clarified the limits; see ${name}.`;
    }
    rec.edit_no += 1;
    rec.last_edit = ev.atIso;
    rec.history.push({ edit_no: rec.edit_no, at: ev.atIso, note: ev.note, changes: changed });
    fs.writeFileSync(file, JSON.stringify(rec, null, 2));
    return { summary: `Edit #${rec.edit_no} of ${ev.task}: ${changed.join("; ") || "no field change"}`, task: ev.task };
  }
  if (ev.type === "code") {
    for (const [p, src] of Object.entries(ev.files)) {
      const full = path.join(SIM_DIR, "repos", ev.repo, p);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, src);
    }
    const sha = commitAll(ev.message, ev.author, ev.atIso);
    return { summary: `Commit ${sha.slice(0, 7)} in ${ev.repo}: "${ev.message}"`, sha, task: ev.task, repo: ev.repo };
  }
  return { summary: `Unknown event ${ev.type}` };
}

async function writeAttachment(dir, t, a) {
  const file = path.join(dir, "attachments", a.name);
  const cap = CAPS[t.capability] || { title: t.title, why: "", rule: "", params: [] };
  if (a.name.endsWith(".docx")) {
    const params = cap.params.map(([n, v, u]) => new Paragraph({ text: `${n.replace(/_/g, " ")}: ${a.rev === "B" ? bump(v) : v} ${u}`, bullet: { level: 0 } }));
    const doc = new Document({
      creator: "FlexPM", title: `${t.task} specification rev ${a.rev}`,
      sections: [{ children: [
        new Paragraph({ text: `${t.task} ${t.title}`, heading: HeadingLevel.TITLE }),
        new Paragraph({ children: [new TextRun({ text: `Project: ${t.project}   Site: ${t.site}   Revision: ${a.rev}`, italics: true })] }),
        new Paragraph({ text: "1 Background", heading: HeadingLevel.HEADING_1 }),
        new Paragraph(`${cap1(cap.why)}.`),
        new Paragraph({ text: "2 Requirement", heading: HeadingLevel.HEADING_1 }),
        new Paragraph(`${cap.rule}.`),
        ...params,
        new Paragraph({ text: "3 Acceptance criteria", heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ text: "The station refuses the transaction and shows the reason when a limit is not met.", bullet: { level: 0 } }),
        new Paragraph({ text: "Each decision is recorded with operator and timestamp.", bullet: { level: 0 } }),
        ...(a.rev === "B" ? [new Paragraph({ text: "4 Change in revision B", heading: HeadingLevel.HEADING_1 }), new Paragraph("Limits were raised after the line trial; values above replace revision A.")] : []),
      ] }],
    });
    fs.writeFileSync(file, await Packer.toBuffer(doc));
  } else if (a.name.endsWith(".pdf")) {
    await new Promise((resolve, reject) => {
      const pdf = new PDFDocument({ info: { Title: `${t.customer} requirement`, CreationDate: new Date(Date.parse(t.created + "T00:00:00Z")) } });
      const out = fs.createWriteStream(file);
      pdf.pipe(out);
      pdf.fontSize(16).text(`${t.customer} – Customer requirement`, { underline: true });
      pdf.moveDown().fontSize(11).text(`Program ${t.project}`);
      pdf.moveDown().text(`Problem: ${cap1(cap.why)}.`);
      pdf.moveDown().text(`Request: ${cap.rule}. The supplier shall provide evidence of the control in the MES for every unit shipped.`);
      pdf.end();
      out.on("finish", resolve); out.on("error", reject);
    });
  } else {
    fs.writeFileSync(file, `# Meeting notes – ${t.task}\n\n- Attendees: ${t.owner}, line lead, quality engineer\n- Agreed: ${cap.rule.toLowerCase()}.\n- Open point: confirm limits with ${t.customer} before UAT.\n`);
  }
}

const cap1 = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
const bump = (v) => (typeof v === "number" ? (v > 10 ? Math.round(v * 1.2) : v + 1) : v);
