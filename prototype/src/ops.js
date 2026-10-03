// Operations helpers: configuration, structured logs, scheduler runs and the job queue.
import { q, one } from "./db.js";

export const DEFAULT_CONFIG = {
  "sim.seed": 42,
  "sim.interval_sec": 4,
  "sim.events_per_tick": 2,
  "l1.interval_sec": 3,
  "l1.batch_size": 12,
  "l2.interval_sec": 4,
  "l2.batch_size": 10,
  "demo.item_delay_ms": 250,
  "link.inferred_threshold": 0.18,
  "clone.variant_threshold": 0.75,
  "similar.threshold": 0.3,
  "similar.duplicate_threshold": 0.45,
  "card.template_version": "v1",
  "llm.provider": "builtin",
  "llm.model": "Qwen/Qwen3-32B",
};

export const CONFIG_HELP = {
  "sim.seed": "Random seed for the FlexPM simulator. Same seed = same demo story. Applied on Reset.",
  "sim.interval_sec": "Seconds between simulator ticks.",
  "sim.events_per_tick": "FlexPM events (new CR, revision, edit, commit) produced per tick.",
  "l1.interval_sec": "Seconds between L1 normalization runs.",
  "l1.batch_size": "Max L1 jobs processed per run.",
  "l2.interval_sec": "Seconds between L2 card/link runs.",
  "l2.batch_size": "Max L2 jobs processed per run.",
  "demo.item_delay_ms": "Artificial delay per job so you can watch jobs move through Processing.",
  "link.inferred_threshold": "Minimum text similarity for an inferred CR↔commit link.",
  "clone.variant_threshold": "Minimum MinHash similarity to call code a modified copy.",
  "similar.threshold": "Minimum similarity to list a ticket under 'Similar tickets'.",
  "similar.duplicate_threshold": "Similarity above which a cross-site pair is flagged as a possible duplicate.",
  "card.template_version": "Knowledge card template version written on each card.",
  "llm.provider": "builtin = rule-based card writer (no model cost); hf = Hugging Face Inference Providers (needs HF_TOKEN and credits).",
  "llm.model": "Model id used when provider = hf.",
};

let cache = null;
export async function loadConfig() {
  for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
    await q("INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [k, JSON.stringify(v)]);
  }
  const rows = await q("SELECT key, value FROM config");
  cache = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return cache;
}
export const cfg = (k) => (cache && k in cache ? cache[k] : DEFAULT_CONFIG[k]);
export async function setConfig(key, value, by = "console") {
  if (!(key in DEFAULT_CONFIG)) throw new Error(`Unknown setting ${key}`);
  const def = DEFAULT_CONFIG[key];
  if (typeof def === "number") { value = Number(value); if (!Number.isFinite(value)) throw new Error(`${key} must be a number`); }
  else value = String(value);
  const old = cfg(key);
  if (JSON.stringify(old) === JSON.stringify(value)) return false;
  await q("UPDATE config SET value = $2, updated_at = now(), updated_by = $3 WHERE key = $1", [key, JSON.stringify(value), by]);
  await q("INSERT INTO config_audit (key, old_value, new_value, changed_by) VALUES ($1, $2, $3, $4)", [key, JSON.stringify(old), JSON.stringify(value), by]);
  cache[key] = value;
  await log("info", "ADMIN", `Config ${key} changed from ${JSON.stringify(old)} to ${JSON.stringify(value)}`, { by });
  return true;
}

export async function log(level, stage, message, data = null, ctx = {}) {
  await q("INSERT INTO logs (level, stage, run_id, job_id, task, message, data) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [level, stage, ctx.runId || null, ctx.jobId || null, ctx.task || null, message, data ? JSON.stringify(data) : null]);
}

export async function startRun(scheduler, trigger) {
  return (await one("INSERT INTO runs (scheduler, trigger) VALUES ($1, $2) RETURNING id", [scheduler, trigger])).id;
}
export async function finishRun(id, { picked = 0, done = 0, failed = 0, note = null, status = null }) {
  await q("UPDATE runs SET finished_at = now(), picked = $2, done = $3, failed = $4, note = $5, status = $6 WHERE id = $1",
    [id, picked, done, failed, note, status || (failed ? "partial" : "ok")]);
}

export async function enqueue(stage, kind, ref, task, before = null) {
  // Collapse duplicates: one pending job per (stage, kind, ref).
  const existing = await one("SELECT id FROM jobs WHERE stage=$1 AND kind=$2 AND ref=$3 AND status='pending'", [stage, kind, ref]);
  if (existing) return existing.id;
  return (await one("INSERT INTO jobs (stage, kind, ref, task, before) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [stage, kind, ref, task, before ? JSON.stringify(before) : null])).id;
}
export async function claim(stage, n, runId) {
  return q(`UPDATE jobs SET status='processing', started_at=now(), attempts=attempts+1, run_id=$3
            WHERE id IN (SELECT id FROM jobs WHERE stage=$1 AND status='pending' ORDER BY id LIMIT $2)
            RETURNING *`, [stage, n, runId]);
}
export async function complete(job, after) {
  await q("UPDATE jobs SET status='done', finished_at=now(), after=$2, error=NULL WHERE id=$1", [job.id, JSON.stringify(after || {})]);
}
export async function fail(job, err) {
  await q("UPDATE jobs SET status='failed', finished_at=now(), error=$2 WHERE id=$1", [job.id, String(err && err.stack || err).slice(0, 2000)]);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
