// Builds the scripted FlexPM + source-code timeline from a seed. Pure function: same seed,
// same events, so every demo run (and every rebuild after a restart) tells the same story.
import { SITES, OWNERS, DEVS, STATES_FLOW, CAPABILITIES, DUPLICATES } from "./catalog.js";
import { moduleSource, copyWithChanges, utilitySource } from "./codegen.js";

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86400000;
const pad2 = (n) => String(n).padStart(2, "0");
const iso = (t) => new Date(t).toISOString();

export function buildTimeline(seed = 42, targetTickets = 100) {
  const r = rng(seed);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const between = (a, b) => a + Math.floor(r() * (b - a + 1));
  let crNo = 118200;
  const nextCr = () => String((crNo += between(37, 420)));

  const families = [];
  const caps = CAPABILITIES.map((c, i) => ({ ...c, lang: i % 2 === 0 ? "python" : "javascript" }));

  // Origin families: one per capability. Every 6th uses a legacy repo with CR in commit text,
  // and every 6th (offset) a legacy repo with vague commit text (inferred links).
  caps.forEach((cap, i) => {
    const home = SITES[i % SITES.length];
    const style = i % 6 === 4 ? "legacy-strong" : i % 6 === 5 ? "legacy-vague" : "confirmed";
    families.push({ cap, site: home, style, revs: 1 + cap.revs.length, origin: true });
  });
  // Duplicates: same need, built independently at another site.
  DUPLICATES.forEach((d, i) => {
    families.push({ cap: { ...d, lang: i === 0 ? "javascript" : "python" }, site: i === 0 ? SITES[4] : SITES[5], style: "confirmed", revs: 1, duplicate: true });
  });
  // Reuse families: the same capability requested for another site with its own CR (code copied).
  for (const pass of [1, 2]) {
    caps.forEach((cap, i) => {
      if (pass === 2 && i % 2 === 1) return;
      const site = SITES[(i + pass * 2 + 1) % SITES.length];
      families.push({ cap, site, style: "confirmed", revs: between(1, 2), reuse: true });
    });
  }

  // Trim or pad to the target number of tickets (task revisions).
  let total = families.reduce((s, f) => s + f.revs, 0);
  const noCodeNeeded = 5;
  while (total > targetTickets - noCodeNeeded) {
    const f = families.filter((x) => x.reuse && x.revs > 1).pop() || families.filter((x) => x.reuse).pop();
    if (f.revs > 1) f.revs--; else families.splice(families.indexOf(f), 1);
    total = families.reduce((s, x) => s + x.revs, 0);
  }
  while (total < targetTickets) {
    families.push({ cap: pick(caps), site: pick(SITES), style: "nocode", revs: 1, nocode: true });
    total++;
  }

  // Assign dates: origins spread 2019..2024, reuse later, no-code in 2026.
  const start = Date.parse("2019-01-07T02:00:00Z");
  const originStart = {};
  families.forEach((f, i) => {
    f.cr = nextCr();
    const base = f.origin ? start + i * 95 * DAY
      : f.duplicate ? Date.parse("2023-03-01T02:00:00Z") + i * 20 * DAY
      : f.nocode ? Date.parse("2026-05-01T02:00:00Z") + between(0, 120) * DAY
      : Date.parse("2021-06-01T02:00:00Z") + between(0, 1500) * DAY;
    f.start = base + between(0, 20) * DAY;
    if (f.origin) originStart[f.cap.key] = f.start;
    // A reuse request always comes after the original was built.
    if (f.reuse && originStart[f.cap.key]) f.start = Math.max(f.start, originStart[f.cap.key] + between(400, 700) * DAY);
  });

  const events = [];
  const legacyRepo = (s) => `${s.region}-${s.customer}-ShopfloorExt`;
  const flexRepo = (f) => `${f.site.region}-${f.site.customer}-FLEXPM${f.cr}-${f.cap.feature}`;
  const originOf = {};
  const ticketsByFamily = [];

  for (const f of families) {
    const owner = pick(OWNERS);
    const dev = pick(DEVS);
    let t = f.start;
    const project = `MES_${f.site.site}_${f.site.customer}_${f.site.program} ${f.site.line} [P-${between(20000, 29999)}]`;
    const repo = f.style === "confirmed" ? flexRepo(f) : f.style.startsWith("legacy") ? legacyRepo(f.site) : null;
    const ext = f.cap.lang === "python" ? "py" : "js";
    const filePath = repo ? (f.style === "confirmed" ? `src/${f.cap.key}.${ext}` : `modules/${f.cap.key}.${ext}`) : null;
    for (let k = 1; k <= f.revs; k++) {
      const task = `${f.cr}-${pad2(k)}`;
      const revText = k === 1 ? null : f.cap.revs[k - 2] || `extend ${f.cap.title.toLowerCase()} for ${f.site.site}`;
      const paramsShift = f.reuse ? 1 : 0;
      const ticket = {
        task, cr: f.cr, rev: k, capability: f.cap.key,
        title: k === 1 ? `${f.cap.title} – ${f.site.line}` : `${f.cap.title}: ${revText}`,
        project, site: f.site.site, customer: f.site.customer, region: f.site.region,
        priority: pick(["P1", "P2", "P2", "P3"]),
        state: f.nocode ? pick(["IN DEV. LEAD APPROVAL", "NOT IMPLEMENTED"]) : "IN IMPLEMENT",
        owner, created: iso(t).slice(0, 10), required: iso(t + between(30, 90) * DAY).slice(0, 10),
        old_no: r() < 0.3 ? `OLD-${between(1000, 9999)}` : "",
        cuat: "",
        description: description(f, k, revText),
        attachments: attachmentPlan(f, k, revText, r),
      };
      events.push({ at: t, type: "ticket_new", task, ticket });
      ticketsByFamily.push(task);

      if (repo) {
        const ct = t + between(7, 40) * DAY;
        let source;
        if (f.reuse && k === 1) {
          const o = originOf[f.cap.key];
          source = copyWithChanges(o ? o.source : moduleSource(f.cap, 1, f.site), { siteFilter: null, bump: paramsShift });
        } else {
          source = moduleSource(f.cap, k, f.site, f.reuse ? { site: f.site.site } : null);
        }
        if (f.origin && k === 1) originOf[f.cap.key] = { source, site: f.site, repo, path: filePath };
        const message = commitMessage(f, k, task, revText, r);
        events.push({ at: ct, type: "code", task, repo, files: { [filePath]: source }, message, author: dev });
        // State moves forward over time (ticket edits).
        let st = ct;
        const steps = between(1, 3);
        for (let s = 0; s < steps; s++) {
          st += between(10, 60) * DAY;
          const state = STATES_FLOW[Math.min(STATES_FLOW.length - 1, 2 + s + (k > 1 ? 1 : 0))];
          const ed = { state };
          if (s === 0 && r() < 0.35) { ed.required = iso(st + 45 * DAY).slice(0, 10); ed.spec_rev = "B"; }
          if (state.includes("UAT") && r() < 0.5) ed.cuat = iso(st).slice(0, 10);
          events.push({ at: st, type: "ticket_edit", task, changes: ed, note: ed.spec_rev ? "Customer updated the specification (rev B)." : `Moved to ${state}.` });
        }
      }
      t += between(120, 300) * DAY;
    }
  }

  // Plug-and-play copies: code copied to another site's legacy repo with no CR at all.
  const copies = [["label_reprint", SITES[3], 5, "port label reprint changes for GDL line 2"],
                  ["tray_serial", SITES[5], 60, "add tray check from APAC"],
                  ["stencil_life", SITES[2], 30000, "stencil counter for BKK"]];
  for (const [key, site, val, msg] of copies) {
    const o = originOf[key]; if (!o) continue;
    const at = Date.parse("2022-03-14T02:00:00Z") + between(0, 500) * DAY;
    const ext = o.path.endsWith(".py") ? "py" : "js";
    events.push({ at, type: "code", task: null, repo: legacyRepo(site), files: { [`modules/${key}.${ext}`]: copyWithChanges(o.source, { siteFilter: site.site, firstValue: val }) }, message: msg, author: pick(DEVS), plugAndPlay: true });
  }
  // Code nobody can link: a housekeeping script.
  events.push({ at: Date.parse("2020-09-09T02:00:00Z"), type: "code", task: null, repo: legacyRepo(SITES[0]), files: { "scripts/purge_logs.py": utilitySource() }, message: "housekeeping", author: DEVS[0] });

  events.sort((a, b) => a.at - b.at || (a.type === "ticket_new" ? -1 : 1));
  events.forEach((e, i) => { e.seq = i; e.atIso = iso(e.at); });
  return { seed, events, tickets: ticketsByFamily.length, families: families.length };
}

function description(f, k, revText) {
  const c = f.cap;
  const params = c.params.map(([n, v, u]) => `- ${n.replace(/_/g, " ")}: ${f.reuse ? bumpValue(v) : v} ${u}`).join("\n");
  if (k === 1) {
    return `Background\n${cap1(c.why)}.\n\nRequirement\n${c.rule} at ${f.site.site} (${f.site.line}).\n${params}\n\nAcceptance\n- The station blocks the transaction when the rule fails and shows the reason.\n- Every decision is stored for traceability.`;
  }
  return `Background\nExtension of ${f.cr}-${pad2(k - 1)} (${c.title}).\n\nRequirement\n${cap1(revText)}.\n\nAcceptance\n- Existing behaviour of ${f.cr}-${pad2(k - 1)} is unchanged.\n- New behaviour verified in UAT at ${f.site.site}.`;
}

function attachmentPlan(f, k, revText, r) {
  const list = [{ name: `${f.cr}-${pad2(k)}_spec_revA.docx`, kind: "spec", rev: "A" }];
  if (k === 1 && r() < 0.5) list.push({ name: "customer_requirement.pdf", kind: "customer" });
  if (r() < 0.3) list.push({ name: "meeting_notes.md", kind: "notes" });
  return list;
}

function commitMessage(f, k, task, revText, r) {
  const what = k === 1 ? `implement ${f.cap.title.toLowerCase()}` : revText;
  if (f.style === "confirmed") return `FLEXPM${task}: ${what}`;
  if (f.style === "legacy-strong") return `CR ${task} ${what}`;
  return r() < 0.5 ? `update ${f.cap.key.replace(/_/g, " ")} module` : `changes for line ${1 + Math.floor(r() * 5)}`;
}

const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const bumpValue = (v) => (typeof v === "number" ? (v > 10 ? Math.round(v * 1.2) : v + 1) : v);
export { DAY };
