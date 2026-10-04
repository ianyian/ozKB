// Function tags: a small controlled vocabulary assigned to every knowledge card when L2 writes it.
// In the prototype tags come from keyword rules (source "rule") with the matching words kept as
// evidence; in production the card-writing model picks from the same list (source "llm") and
// experts can add or remove tags (source "expert"). Tags feed search, Ask, Check before you build
// and the Functions page.

export const TAGS = [
  { tag: "Labeling", words: ["label", "labels", "reprint", "print", "printing"] },
  { tag: "Traceability", words: ["serial", "trace", "traceability", "lot code", "lot codes", "recall"] },
  { tag: "Authorization", words: ["supervisor", "badge", "approval", "approve", "approver", "certified", "certification", "override"] },
  { tag: "Audit trail", words: ["audit", "log", "logged", "recorded", "record"] },
  { tag: "Notification", words: ["e-mail", "email", "notify", "warn", "alert", "escalate", "escalation"] },
  { tag: "SMT process", words: ["smt", "stencil", "solder", "paste", "reflow", "oven", "pick-and-place", "feeder", "reel", "moisture", "msl"] },
  { tag: "Material control", words: ["reel", "reels", "material", "lot", "lots", "hold", "jar", "expiry", "expired", "floor life", "bake"] },
  { tag: "Equipment & machine setup", words: ["machine", "feeder", "slot", "printer", "oven", "recipe", "profile", "chamber", "conveyor", "tool"] },
  { tag: "Quality & rework", words: ["defect", "defects", "rework", "repair", "scrap", "aoi", "false call", "material review", "quality"] },
  { tag: "Test & inspection", words: ["inspection", "inspect", "first article", "burn-in", "test", "aoi", "profile", "verify", "verification"] },
  { tag: "Packing & shipping", words: ["carton", "packing", "pack", "shipped", "shipment", "tray", "weight", "accessories"] },
  { tag: "Operator management", words: ["operator", "operators", "skill", "trainee", "trainer", "esd", "wrist strap", "certified"] },
  { tag: "Firmware & software", words: ["firmware", "software", "version", "flash", "released version"] },
  { tag: "Assembly", words: ["torque", "screw", "joint", "assembly", "box build"] },
  { tag: "Limits & counters", words: ["limit", "limits", "maximum", "minimum", "counter", "count", "cycles", "tolerance"] },
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const RX = TAGS.map((t) => ({ tag: t.tag, rx: t.words.map((w) => ({ w, re: new RegExp(`\\b${esc(w)}\\b`, "i") })) }));

// Returns [{ tag, evidence: [matched words] }], strongest first. A tag needs two different words,
// or one word that appears in the title (so a single passing mention does not tag a card).
// Text that says nothing about the function itself: production line names and the acceptance
// boilerplate every spec template carries.
const NOISE = [/\b(final assembly|box build|smt|test and pack) line \d+\b/gi, /line \d+ rollout/gi,
  /The station (blocks|refuses) the transaction[^.]*\./gi, /Every decision is stored for traceability\./gi,
  /Each decision is recorded with operator and timestamp\./gi, /Existing behaviour of [^.]*\./gi, /New behaviour verified in UAT[^.]*\./gi,
  /Store the decision in \w+ for traceability\.?/gi, /\[P-\d+\]/g];
export const cleanForTags = (text) => NOISE.reduce((t, re) => t.replace(re, " "), String(text || ""));

export function tagText(text, title = "") {
  text = cleanForTags(text); title = cleanForTags(title);
  const out = [];
  for (const t of RX) {
    const hits = t.rx.filter((x) => x.re.test(text)).map((x) => x.w);
    const inTitle = t.rx.some((x) => x.re.test(title));
    if (hits.length >= 2 || (hits.length && inTitle)) out.push({ tag: t.tag, evidence: hits.slice(0, 4), score: hits.length + (inTitle ? 2 : 0) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}

// Tags whose name or words appear in a free-text query ("traceability", "packing").
export function tagsInQuery(text) {
  const t = String(text || "").toLowerCase();
  return TAGS.filter((x) => t.includes(x.tag.toLowerCase()) || x.tag.toLowerCase().split(/ & | /).some((w) => w.length > 4 && t.includes(w))).map((x) => x.tag);
}
