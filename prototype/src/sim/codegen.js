// Generates small but realistic-looking Python / Node modules for each capability.
import { DUPLICATE_OF } from "./catalog.js";

const upper = (s) => s.toUpperCase();
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const pascal = (s) => camel(s).replace(/^./, (c) => c.toUpperCase());

export function moduleSource(cap, rev, site, opts = null) {
  if (DUPLICATE_OF[cap.key]) return cap.lang === "python" ? pyClass(cap) : jsClass(cap);
  return cap.lang === "python" ? pyModule(cap, rev, opts) : jsModule(cap, rev, opts);
}

function pyModule(c, rev, opts) {
  const [p1, p2] = c.params;
  let s = `"""${c.title}.\n\n${c.rule}.\n"""\nfrom datetime import datetime\n\n`;
  s += `${upper(p1[0])} = ${p1[1]}  # ${p1[2]}\n${upper(p2[0])} = ${p2[1]}  # ${p2[2]}\n\n\n`;
  s += `def check_${c.key}(${c.entity}, context):\n    """${c.rule}."""\n`;
  s += `    if context.get("${p1[0]}_used", 0) >= ${upper(p1[0])}:\n        return {"allowed": False, "reason": "${p1[0]} reached for ${c.entity}"}\n`;
  s += `    if context.get("${p2[0]}_value", 0) < ${upper(p2[0])}:\n        return {"allowed": False, "reason": "${p2[0]} below limit"}\n`;
  s += `    return {"allowed": True, "reason": None}\n\n\n`;
  s += `def record_${c.key}(db, ${c.entity}, actor, outcome):\n    """Store the decision in ${c.table} for traceability."""\n`;
  s += `    db.insert("${c.table}", {\n        "${c.entity}": ${c.entity},\n        "actor": actor,\n        "allowed": outcome["allowed"],\n        "at": datetime.utcnow().isoformat(),\n    })\n`;
  if (rev >= 2) {
    s += `\n\ndef audit_${c.key}(db, ${c.entity}, actor, detail):\n    """${cap1(c.revs[0] || "audit")}."""\n`;
    s += `    db.insert("${c.table}Log", {"${c.entity}": ${c.entity}, "actor": actor, "detail": detail})\n`;
  }
  if (rev >= 3) {
    s += `\n\ndef notify_${c.key}(mailer, ${c.entity}, recipients):\n    """${cap1(c.revs[1] || "notify")}."""\n`;
    s += `    mailer.send(recipients, subject="${c.title}: ${c.entity} " + str(${c.entity}))\n`;
  }
  if (opts && opts.site) {
    s += `\n\ndef site_rule_${c.key}_${opts.site.toLowerCase()}(context):\n    """Site ${opts.site} specific limit for ${c.title.toLowerCase()}."""\n`;
    s += `    return context.get("line") in ("L1", "L2", "L3")\n`;
  }
  return s;
}

function jsModule(c, rev, opts) {
  const [p1, p2] = c.params;
  const n = pascal(c.key), e = camel(c.entity);
  let s = `// ${c.title}.\n// ${c.rule}.\n'use strict';\n\n`;
  s += `const ${upper(p1[0])} = ${p1[1]}; // ${p1[2]}\nconst ${upper(p2[0])} = ${p2[1]}; // ${p2[2]}\n\n`;
  s += `/** ${c.rule}. */\nfunction check${n}(${e}, context) {\n`;
  s += `  if ((context.${camel(p1[0])}Used || 0) >= ${upper(p1[0])}) {\n    return { allowed: false, reason: '${p1[0]} reached for ${c.entity}' };\n  }\n`;
  s += `  if ((context.${camel(p2[0])}Value || 0) < ${upper(p2[0])}) {\n    return { allowed: false, reason: '${p2[0]} below limit' };\n  }\n  return { allowed: true, reason: null };\n}\n\n`;
  s += `/** Store the decision in ${c.table} for traceability. */\nasync function record${n}(db, ${e}, actor, outcome) {\n`;
  s += `  await db.insert('${c.table}', { ${e}, actor, allowed: outcome.allowed, at: new Date().toISOString() });\n}\n`;
  const exp = [`check${n}`, `record${n}`];
  if (rev >= 2) {
    s += `\n/** ${cap1(c.revs[0] || "audit")}. */\nasync function audit${n}(db, ${e}, actor, detail) {\n  await db.insert('${c.table}Log', { ${e}, actor, detail });\n}\n`;
    exp.push(`audit${n}`);
  }
  if (rev >= 3) {
    s += `\n/** ${cap1(c.revs[1] || "notify")}. */\nasync function notify${n}(mailer, ${e}, recipients) {\n  await mailer.send(recipients, \`${c.title}: ${c.entity} \${${e}}\`);\n}\n`;
    exp.push(`notify${n}`);
  }
  if (opts && opts.site) {
    const fn = `siteRule${n}${opts.site.charAt(0)}${opts.site.slice(1).toLowerCase()}`;
    s += `\n/** Site ${opts.site} specific limit for ${c.title.toLowerCase()}. */\nfunction ${fn}(context) {\n  return ['L1', 'L2', 'L3'].includes(context.line);\n}\n`;
    exp.push(fn);
  }
  s += `\nmodule.exports = { ${exp.join(", ")} };\n`;
  return s;
}

function pyClass(c) {
  const [p1, p2] = c.params;
  return `"""${c.title} (independent implementation).\n\n${c.rule}.\n"""\n\n\nclass ${c.feature}:\n    """${c.rule}."""\n\n` +
    `    def __init__(self, store, ${p1[0]}=${p1[1]}, ${p2[0]}=${p2[1]}):\n        self.store = store\n        self.${p1[0]} = ${p1[0]}\n        self.${p2[0]} = ${p2[0]}\n\n` +
    `    def evaluate(self, ${c.entity}, scans):\n        """Return (ok, message) for a ${c.entity}."""\n        if len(scans) > self.${p1[0]}:\n            return False, "too many"\n` +
    `        bad = [s for s in scans if s[: self.${p2[0]}] != ${c.entity}[: self.${p2[0]}]]\n        if bad:\n            return False, "%d mismatched" % len(bad)\n        self.store.save("${c.table}", ${c.entity}, scans)\n        return True, "ok"\n`;
}

function jsClass(c) {
  const [p1, p2] = c.params;
  return `// ${c.title} (independent implementation).\n// ${c.rule}.\n'use strict';\n\nclass ${c.feature} {\n` +
    `  constructor(store, { ${camel(p1[0])} = ${p1[1]}, ${camel(p2[0])} = ${p2[1]} } = {}) {\n    this.store = store;\n    this.${camel(p1[0])} = ${camel(p1[0])};\n    this.${camel(p2[0])} = ${camel(p2[0])};\n  }\n\n` +
    `  /** Approve or refuse a ${c.entity.replace(/_/g, " ")}. */\n  async decide(${camel(c.entity)}, approver) {\n` +
    `    const count = await this.store.count('${c.table}', ${camel(c.entity)}.serial);\n    if (count >= this.${camel(p2[0])}) return { ok: false, why: 'cap reached' };\n` +
    `    if ((approver.level || 0) < this.${camel(p1[0])}) return { ok: false, why: 'approval level' };\n    await this.store.add('${c.table}', { serial: ${camel(c.entity)}.serial, approver: approver.id });\n    return { ok: true };\n  }\n}\n\nmodule.exports = { ${c.feature} };\n`;
}

// Plug-and-play copy: same code, first constant changed, optional site filter added.
export function copyWithChanges(src, { siteFilter = null, firstValue = null, bump = 0 } = {}) {
  let out = src;
  const m = out.match(/^(?:const )?([A-Z_]+) = (\d+)/m);
  if (m) {
    const v = firstValue != null ? firstValue : bump ? Math.round(Number(m[2]) * 1.2) || Number(m[2]) + 1 : Number(m[2]);
    out = out.replace(m[0], m[0].replace(m[2], String(v)));
  }
  if (siteFilter) {
    out = out.includes("'use strict'")
      ? out.replace("'use strict';\n", `'use strict';\n\nconst SITE_FILTER = '${siteFilter}';\n`)
      : out.replace("from datetime import datetime\n", `from datetime import datetime\n\nSITE_FILTER = "${siteFilter}"\n`);
    // The copy is also edited: the check only applies at the copying site.
    out = out.includes("'use strict'")
      ? out.replace(/(function check\w+\([^)]*\) \{\n)/, `$1  if (context.site !== SITE_FILTER) {\n    return { allowed: true, reason: 'not enforced at this site' };\n  }\n`)
      : out.replace(/(def check_\w+\([^)]*\):\n    """[^\n]*"""\n)/, `$1    if context.get("site") != SITE_FILTER:\n        return {"allowed": True, "reason": "not enforced at this site"}\n`);
  }
  return out;
}

export function utilitySource() {
  return `"""Housekeeping."""\nimport os\nimport time\n\n\ndef purge_old_logs(folder, days=30):\n    """Delete log files older than the given number of days."""\n` +
    `    cutoff = time.time() - days * 86400\n    for name in os.listdir(folder):\n        path = os.path.join(folder, name)\n        if name.endswith(".log") and os.path.getmtime(path) < cutoff:\n            os.remove(path)\n`;
}

const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);
