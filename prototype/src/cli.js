// Command line: `node src/cli.js reset` or `node src/cli.js demo [events]` (headless full run).
import { initDb, q, one } from "./db.js";
import { loadConfig, setConfig } from "./ops.js";
import { resetAll } from "./sim/runner.js";
import { schedulers } from "./scheduler.js";

await initDb();
await loadConfig();
const [cmd, arg] = process.argv.slice(2);
if (cmd === "reset") {
  await resetAll("cli");
  console.log("Reset done.");
} else if (cmd === "demo") {
  await setConfig("demo.item_delay_ms", 0, "cli");
  await setConfig("sim.events_per_tick", 25, "cli");
  await setConfig("l1.batch_size", 200, "cli");
  await setConfig("l2.batch_size", 200, "cli");
  await resetAll("cli");
  const limit = arg ? Number(arg) : Infinity;
  let played = 0;
  const t0 = Date.now();
  for (;;) {
    const s = await schedulers.SIM.runOnce();
    played += s.done || 0;
    await schedulers.L1.runOnce();
    for (let i = 0; i < 5; i++) { const r = await schedulers.L2.runOnce(); if (!r.picked) break; }
    if (s.finished || played >= limit || !s.done) break;
  }
  for (let i = 0; i < 20; i++) {
    const a = await schedulers.L1.runOnce(); const b = await schedulers.L2.runOnce();
    if (!a.picked && !b.picked) break;
  }
  const c = async (sql) => (await one(sql)).n;
  console.log(`played ${played} events in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("tickets", await c("SELECT count(*)::int n FROM tickets"), "docs", await c("SELECT count(*)::int n FROM documents"),
    "commits", await c("SELECT count(*)::int n FROM commits"), "units", await c("SELECT count(*)::int n FROM code_units"),
    "cards", await c("SELECT count(*)::int n FROM cards"), "clone groups", await c("SELECT count(*)::int n FROM clone_groups"));
  console.log("links by tier", await q("SELECT tier, count(*)::int n FROM links GROUP BY tier ORDER BY tier"));
  console.log("card confidence", await q("SELECT link_confidence, count(*)::int n FROM cards GROUP BY 1 ORDER BY 1"));
  console.log("review", await q("SELECT kind, count(*)::int n FROM review_items GROUP BY kind"));
  console.log("jobs", await q("SELECT stage, status, count(*)::int n FROM jobs GROUP BY 1,2 ORDER BY 1,2"));
  console.log("errors", await q("SELECT stage, message FROM logs WHERE level='error' LIMIT 5"));
}
process.exit(0);
