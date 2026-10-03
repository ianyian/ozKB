// Minimal scheduler engine: each scheduler runs on its own interval, never overlaps itself,
// records a row in `runs`, and can be started, stopped or run once from the console.
import { cfg, startRun, finishRun, log } from "./ops.js";
import { simTick } from "./sim/runner.js";
import * as L1 from "./l1.js";
import * as L2 from "./l2.js";

class Scheduler {
  constructor(name, label, intervalKey, fn) {
    Object.assign(this, { name, label, intervalKey, fn, running: false, busy: false, timer: null, last: null, lastError: null, runs: 0 });
  }
  status() {
    return { name: this.name, label: this.label, running: this.running, busy: this.busy, interval_sec: cfg(this.intervalKey), last: this.last, last_error: this.lastError, runs: this.runs };
  }
  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      await this.runOnce("schedule");
      if (this.running) this.timer = setTimeout(loop, cfg(this.intervalKey) * 1000);
    };
    loop();
  }
  stop() { this.running = false; clearTimeout(this.timer); }
  async runOnce(trigger = "manual") {
    if (this.busy) return { skipped: true };
    this.busy = true;
    let runId = null;
    try {
      runId = await startRun(this.name, trigger);
      const r = await this.fn(runId);
      await finishRun(runId, r);
      this.last = { at: new Date().toISOString(), ...r };
      this.lastError = null;
      this.runs++;
      if (r.finished && this.name === "SIM") { this.stop(); await log("info", "SIM", "Simulator reached the end of the timeline and stopped"); }
      return r;
    } catch (e) {
      this.lastError = e.message;
      if (runId) await finishRun(runId, { failed: 1, note: e.message, status: "error" }).catch(() => {});
      await log("error", this.name, `Run failed: ${e.message}`, { stack: String(e.stack).slice(0, 800) }, { runId }).catch(() => {});
      return { error: e.message };
    } finally {
      this.busy = false;
    }
  }
}

async function l1Run(runId) {
  const s = await L1.scan({ runId });
  const r = await L1.processBatch(runId);
  return { ...r, note: `scan: ${s.changed} file(s), ${s.commits} commit(s)` };
}

export const schedulers = {
  SIM: new Scheduler("SIM", "FlexPM simulator", "sim.interval_sec", simTick),
  L1: new Scheduler("L1", "L1 · Normalize", "l1.interval_sec", l1Run),
  L2: new Scheduler("L2", "L2 · Cards & links", "l2.interval_sec", (runId) => L2.processBatch(runId)),
};
export const stopAll = () => Object.values(schedulers).forEach((s) => s.stop());
export async function waitIdle() {
  while (Object.values(schedulers).some((s) => s.busy)) await new Promise((r) => setTimeout(r, 100));
}
