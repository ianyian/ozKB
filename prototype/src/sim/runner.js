// FlexPM simulator scheduler: plays the scripted timeline into the raw store, a few events per tick.
import { q, one } from "../db.js";
import { cfg, log } from "../ops.js";
import { buildTimeline } from "./timeline.js";
import { applyEvent, resetStore, storeReady } from "./store.js";

let cached = null;
export function timeline(seed) {
  if (!cached || cached.seed !== seed) cached = buildTimeline(seed);
  return cached;
}

export async function simState() {
  let s = await one("SELECT * FROM sim_state WHERE id=1");
  if (!s) {
    const seed = cfg("sim.seed");
    await q("INSERT INTO sim_state (id, seed, cursor, total_events) VALUES (1, $1, 0, $2)", [seed, timeline(seed).events.length]);
    s = await one("SELECT * FROM sim_state WHERE id=1");
  }
  return s;
}

// After a container restart the raw store is gone but the database remembers the cursor:
// replay the same deterministic events to rebuild identical files and commits.
export async function ensureStore() {
  const s = await simState();
  if (storeReady()) return;
  resetStore();
  const tl = timeline(s.seed);
  for (let i = 0; i < s.cursor; i++) await applyEvent(tl.events[i]);
  if (s.cursor) await log("info", "SIM", `Rebuilt raw store by replaying ${s.cursor} event(s)`);
}

export async function simTick(runId) {
  await ensureStore();
  const s = await simState();
  const tl = timeline(s.seed);
  const n = cfg("sim.events_per_tick");
  let done = 0;
  for (let i = 0; i < n && s.cursor + done < tl.events.length; i++) {
    const ev = tl.events[s.cursor + done];
    const r = await applyEvent(ev);
    done++;
    await q("UPDATE sim_state SET cursor=$1, sim_clock=$2 WHERE id=1", [s.cursor + done, ev.atIso]);
    await log("info", "SIM", r.summary, { type: ev.type, seq: ev.seq, sim_time: ev.atIso, sha: r.sha ? r.sha.slice(0, 7) : null, plug_and_play: !!ev.plugAndPlay }, { runId, task: r.task || ev.task || null });
  }
  const finished = s.cursor + done >= tl.events.length;
  return { picked: done, done, failed: 0, note: finished ? "Timeline complete" : `${s.cursor + done}/${tl.events.length} events`, finished };
}

export async function resetAll(by = "console") {
  await q(`TRUNCATE jobs, logs, runs, source_files, tickets, ticket_versions, documents, commits, code_units, links,
           clone_groups, clone_members, cards, card_history, similar_tickets, review_items, sim_state RESTART IDENTITY`);
  resetStore();
  const seed = cfg("sim.seed");
  await q("INSERT INTO sim_state (id, seed, cursor, total_events) VALUES (1, $1, 0, $2)", [seed, timeline(seed).events.length]);
  await log("warn", "ADMIN", `Demo reset by ${by}: all pipeline data cleared, simulator rewound (seed ${seed}, ${timeline(seed).events.length} events, ${timeline(seed).tickets} tickets)`);
}
