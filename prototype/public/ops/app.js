// KB Hub prototype UI: tiny hash router, live refresh, operations console and knowledge portal.
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtT = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");
const fmtD = (t) => (t ? new Date(t).toISOString().slice(0, 10) : "—");
const tag = (v, cls) => `<span class="tag ${esc(cls || v)}">${esc(v)}</span>`;
const view = $("#view");
let timer = null, current = null, statusCache = null;

function adminKey() { try { return sessionStorage.getItem("kbhub-admin") || ""; } catch { return ""; } }
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", "x-admin-key": adminKey(), ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    toast("Admin password needed. Enter it on the Control page.");
    throw new Error(body.error);
  }
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body || {}) });
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3200); }
function drawer(html) { $("#drawer-body").innerHTML = html; $("#drawer").hidden = false; }
$("#drawer-x").onclick = () => ($("#drawer").hidden = true);
$("#drawer").onclick = (e) => { if (e.target.id === "drawer") $("#drawer").hidden = true; };
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#drawer").hidden = true; });

// ---------------- chrome ----------------
async function refreshStatus() {
  try {
    const s = await api("/api/status");
    statusCache = s;
    $("#pills").innerHTML = s.schedulers.map((x) => `<span class="pill ${x.last_error ? "err" : x.busy ? "busy" : x.running ? "on" : "off"}" title="${esc(x.label)}"><i></i>${esc(x.name)} ${x.running ? "running" : "stopped"}</span>`).join("")
      + `<span class="pill" title="Simulated FlexPM time">${s.sim.cursor}/${s.sim.total} events · ${fmtD(s.sim.sim_clock)}</span>`;
    $("#side-foot").innerHTML = `<span>Database: <b>${s.db === "postgres" ? "Neon Postgres" : "embedded PGlite"}</b></span><span>Card writer: <b>${s.llm.provider === "hf" ? esc(s.llm.model) : "built-in"}</b></span><span>Seed ${s.sim.seed}</span>`;
    const rv = await api("/api/review?status=open");
    $("#rev-count").textContent = rv.length || "";
  } catch (e) { $("#pills").innerHTML = `<span class="pill err"><i></i>server unreachable</span>`; }
}

// ---------------- router ----------------
const routes = {};
function route(name, def) { routes[name] = def; }
async function go() {
  const [name = "dashboard", ...args] = location.hash.replace(/^#\/?/, "").split("?")[0].split("/").map(decodeURIComponent);
  const r = routes[name] || routes.dashboard;
  clearInterval(timer);
  current = r;
  $$(".side nav a").forEach((a) => a.classList.toggle("on", a.dataset.nav === (r.nav || name)));
  $("#crumbs").textContent = r.crumb ? r.crumb(args) : r.title;
  view.innerHTML = `<div class="muted">Loading…</div>`;
  try {
    await r.render(args);
    if (r.refresh) { await r.refresh(args); timer = setInterval(() => current === r && r.refresh(args).catch(() => {}), 2000); }
  } catch (e) { view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", go);
setInterval(refreshStatus, 2000);

// ---------------- dashboard ----------------
route("dashboard", {
  title: "Dashboard",
  async render() {
    view.innerHTML = `
      <div class="head"><div><h1>Pipeline dashboard</h1><p>Simulated FlexPM and source code flowing through L1 normalization and L2 knowledge cards into the index. Refreshes every 2 seconds.</p></div>
        <div class="row"><button class="btn primary" id="d-start">Start all schedulers</button><button class="btn" id="d-stop">Stop all</button></div></div>
      <div class="grid g8" id="d-kpi"></div>
      <div class="card"><h3>Pipeline <span class="small muted">jobs waiting / running at each stage</span></h3><div class="flow" id="d-flow"></div></div>
      <div class="grid g2">
        <div class="card"><h3>Throughput <span class="small muted">jobs completed per minute, last 30 min</span></h3><div id="d-thr"></div></div>
        <div class="card"><h3>Knowledge cards by link confidence</h3><div id="d-tiers"></div><h3 style="margin-top:16px">Open review items</h3><div id="d-rev"></div></div>
      </div>
      <div class="grid g2">
        <div class="card"><h3>Recent scheduler runs <a class="small" href="#/runs">All runs</a></h3><div class="tbl-wrap" id="d-runs"></div></div>
        <div class="card"><h3>Tickets per site <a class="small" href="#/sites">Sites</a></h3><div id="d-sites"></div><h3 style="margin-top:16px">Latest errors <a class="small" href="#/logs?level=error">Logs</a></h3><div id="d-err"></div></div>
      </div>`;
    $("#d-start").onclick = async () => { await post("/api/scheduler/all/start"); toast("All schedulers started"); refreshStatus(); };
    $("#d-stop").onclick = async () => { await post("/api/scheduler/all/stop"); toast("All schedulers stopped"); refreshStatus(); };
  },
  async refresh() {
    const d = await api("/api/dashboard");
    const s = statusCache || (await api("/api/status"));
    const c = d.counts;
    $("#d-kpi").innerHTML = [["Tickets", c.tickets], ["Attachments", c.docs], ["Commits", c.commits], ["Code units", c.units], ["Knowledge cards", c.cards], ["Clone groups", c.groups], ["Open reviews", c.openReview], ["Errors (1 h)", c.errors1h, c.errors1h ? "alert" : ""]]
      .map(([k, v, cls]) => `<div class="kpi ${cls || ""}"><b>${v}</b><span>${k}</span></div>`).join("");
    const qn = (st, status) => (d.queue.find((x) => x.stage === st && x.status === status) || { n: 0 }).n;
    $("#d-flow").innerHTML = `
      <div><span class="lbl">FlexPM simulator</span><b>${s.sim.cursor}<span class="small"> / ${s.sim.total}</span></b><span>events played · ${fmtD(s.sim.sim_clock)}</span></div>
      <div><span class="lbl">L1 · Normalize</span><b>${qn("L1", "pending")} <span class="small">waiting</span></b><span>${qn("L1", "processing")} running · ${qn("L1", "done")} done · ${qn("L1", "failed")} failed</span></div>
      <div><span class="lbl">L2 · Cards &amp; links</span><b>${qn("L2", "pending")} <span class="small">waiting</span></b><span>${qn("L2", "processing")} running · ${qn("L2", "done")} done · ${qn("L2", "failed")} failed</span></div>
      <div><span class="lbl">L3 · Index</span><b>${c.cards}</b><span>cards searchable · ${c.units} code units</span></div>
      <div><span class="lbl">Review</span><b>${c.openReview}</b><span>items need an expert</span></div>`;
    $("#d-thr").innerHTML = throughputChart(d.throughput);
    const total = d.tiers.reduce((a, b) => a + b.n, 0) || 1;
    const colors = { confirmed: "var(--ok)", strong: "var(--blue)", inferred: "var(--warn)", unlinked: "var(--grey)" };
    const order = ["confirmed", "strong", "inferred", "unlinked"];
    $("#d-tiers").innerHTML = `<div class="bar">${order.map((k) => { const n = (d.tiers.find((t) => t.k === k) || { n: 0 }).n; return n ? `<span style="width:${(100 * n) / total}%;background:${colors[k]}" title="${k}: ${n}"></span>` : ""; }).join("")}</div>
      <div class="legend">${order.map((k) => `<span><i style="background:${colors[k]}"></i>${k} ${(d.tiers.find((t) => t.k === k) || { n: 0 }).n}</span>`).join("")}</div>`;
    $("#d-rev").innerHTML = d.reviewKinds.length ? `<div class="row">${d.reviewKinds.map((r) => `<a href="#/review">${tag(`${r.k.replace("_", " ")} · ${r.n}`, "open")}</a>`).join("")}</div>` : `<span class="muted small">Nothing waiting.</span>`;
    $("#d-runs").innerHTML = runsTable(d.recent);
    $("#d-sites").innerHTML = d.sites.length ? `<div class="row">${d.sites.map((x) => `<a href="#/site/${x.k}">${tag(`${x.k} · ${x.n}`, "unlinked")}</a>`).join("")}</div>` : `<span class="muted small">No tickets yet.</span>`;
    $("#d-err").innerHTML = d.lastErrors.length ? d.lastErrors.map((e) => `<div class="small">${fmtT(e.ts)} ${tag(e.stage, "error")} ${esc(e.message)}</div>`).join("") : `<span class="muted small">No errors.</span>`;
  },
});

function throughputChart(rows) {
  const mins = [...new Set(rows.map((r) => r.m))];
  if (!mins.length) return `<div class="empty">No completed jobs in the last 30 minutes. Start the schedulers to see throughput.</div>`;
  const W = 560, H = 150, pad = 26, bw = Math.max(4, Math.min(22, (W - pad * 2) / mins.length - 4));
  const val = (m, st) => (rows.find((r) => r.m === m && r.stage === st) || { n: 0 }).n;
  const max = Math.max(1, ...mins.map((m) => val(m, "L1") + val(m, "L2")));
  const x = (i) => pad + i * ((W - pad * 2) / mins.length);
  const y = (v) => H - 20 - (v / max) * (H - 40);
  let bars = "";
  mins.forEach((m, i) => {
    const a = val(m, "L1"), b = val(m, "L2");
    bars += `<rect x="${x(i)}" y="${y(a)}" width="${bw}" height="${H - 20 - y(a)}" fill="var(--blue)"><title>${m} L1 ${a}</title></rect>`;
    bars += `<rect x="${x(i)}" y="${y(a + b)}" width="${bw}" height="${y(a) - y(a + b)}" fill="var(--accent-fill)"><title>${m} L2 ${b}</title></rect>`;
    if (i % Math.ceil(mins.length / 6) === 0) bars += `<text x="${x(i)}" y="${H - 5}">${m}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Jobs completed per minute"><line x1="${pad}" x2="${W - pad}" y1="${H - 20}" y2="${H - 20}" stroke="var(--line)"/><text x="0" y="${y(max) + 4}">${max}</text>${bars}</svg>
    <div class="legend"><span><i style="background:var(--blue)"></i>L1 normalize</span><span><i style="background:var(--accent-fill)"></i>L2 cards &amp; links</span></div>`;
}
function runsTable(rows) {
  if (!rows.length) return `<div class="empty">No runs yet.</div>`;
  return `<table><thead><tr><th>Run</th><th>Scheduler</th><th>Status</th><th>Started</th><th class="num">Picked</th><th class="num">Done</th><th class="num">Failed</th><th>Note</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="mono">#${r.id}</td><td>${esc(r.scheduler)}</td><td>${tag(r.status)}</td><td>${fmtT(r.started_at)}</td><td class="num">${r.picked}</td><td class="num">${r.done}</td><td class="num">${r.failed}</td><td class="small muted">${esc(r.note || "")}</td></tr>`).join("")}</tbody></table>`;
}

// ---------------- control & configuration ----------------
route("console", {
  title: "Control & configuration", nav: "console",
  async render() {
    view.innerHTML = `
      <div class="head"><div><h1>Control &amp; configuration</h1><p>Start, stop or single-step each scheduler. Reset rewinds the whole demo to an empty knowledge base and a fresh FlexPM timeline, so you can present it again.</p></div>
        <div class="row" id="admin-row"></div></div>
      <div class="grid g3" id="c-sched"></div>
      <div class="card"><h3>Demo reset</h3>
        <p class="small muted" style="margin:0 0 8px">Clears tickets, cards, links, jobs, logs and runs, deletes the simulated raw store and rewinds the simulator to event 0 with the configured seed. Configuration is kept.</p>
        <div class="row" id="reset-area"><button class="btn danger" id="c-reset">Reset demo…</button>
          <button class="btn primary" id="c-full">Reset and load full demo</button><span class="small muted" id="ff-state"></span></div>
        <p class="small muted" style="margin:8px 0 0">Load full demo plays all 383 events (100 tickets) through L1 and L2 at full speed, so the engineer portal has complete data. Watch progress on the Dashboard.</p></div>
      <div class="card"><h3>Configuration <span class="row"><button class="btn primary sm" id="c-save">Save changes</button></span></h3><div class="cfg" id="c-cfg"></div></div>
      <div class="card"><h3>Configuration change history</h3><div class="tbl-wrap" id="c-audit"></div></div>`;
    const s = statusCache || (await api("/api/status"));
    if (s.admin_required) {
      $("#admin-row").innerHTML = `<input id="adm" type="password" placeholder="Admin password" value="${esc(adminKey())}"><button class="btn sm" id="adm-save">Use</button>`;
      $("#adm-save").onclick = () => { try { sessionStorage.setItem("kbhub-admin", $("#adm").value); } catch {} toast("Admin password set for this browser tab"); };
    }
    $("#c-full").onclick = async () => { $("#c-full").disabled = true; await post("/api/admin/load-full-demo", { reset: true }); toast("Loading the full demo. Watch the Dashboard."); refreshStatus(); };
    $("#c-reset").onclick = () => {
      $("#reset-area").innerHTML = `<div class="confirm"><b>Reset the whole demo?</b><span class="small">All schedulers stop. This cannot be undone.</span>
        <div class="row"><button class="btn danger" id="c-reset-yes">Yes, reset</button><button class="btn" id="c-reset-no">Cancel</button></div></div>`;
      $("#c-reset-no").onclick = () => go();
      $("#c-reset-yes").onclick = async () => { $("#c-reset-yes").disabled = true; await post("/api/admin/reset"); toast("Demo reset. Press Start to run it again."); refreshStatus(); go(); };
    };
    const cfg = await api("/api/config");
    $("#c-cfg").innerHTML = cfg.map((c) => {
      const v = c.value;
      const input = c.key === "llm.provider"
        ? `<select data-k="${c.key}"><option value="builtin" ${v === "builtin" ? "selected" : ""}>builtin</option><option value="hf" ${v === "hf" ? "selected" : ""}>hf (Hugging Face)</option></select>`
        : `<input data-k="${c.key}" value="${esc(v)}" ${typeof c.default === "number" ? 'type="number" step="any"' : ""}>`;
      return `<div class="cfg-row"><label for="k-${c.key}">${esc(c.key)}</label>${input.replace("data-k", `id="k-${c.key}" data-k`)}<span class="small">${esc(c.help || "")} <span class="muted">Default ${esc(c.default)}. Last change ${fmtD(c.updated_at)} by ${esc(c.updated_by)}.</span></span></div>`;
    }).join("");
    $("#c-save").onclick = async () => {
      const body = {}; $$("[data-k]").forEach((i) => (body[i.dataset.k] = i.value));
      const r = await post("/api/config", body);
      toast(r.changed.length ? `Saved: ${r.changed.join(", ")}` : "No changes to save");
      this.loadAudit();
    };
    this.loadAudit();
  },
  async loadAudit() {
    const a = await api("/api/config/audit");
    $("#c-audit").innerHTML = a.length ? `<table><thead><tr><th>When</th><th>Setting</th><th>Old</th><th>New</th><th>By</th></tr></thead><tbody>${a.map((r) => `<tr><td>${fmtD(r.changed_at)} ${fmtT(r.changed_at)}</td><td class="mono">${esc(r.key)}</td><td>${esc(JSON.stringify(r.old_value))}</td><td>${esc(JSON.stringify(r.new_value))}</td><td>${esc(r.changed_by)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">No changes yet.</div>`;
  },
  async refresh() {
    const [s, j] = await Promise.all([api("/api/status"), api("/api/jobs")]);
    const ff = s.fast_forward; const fs = $("#ff-state");
    if (fs) { fs.textContent = ff.running ? `Loading full demo… ${s.sim.cursor}/${s.sim.total} events` : ff.finishedAt ? `Full demo loaded ${fmtT(ff.finishedAt)}${ff.error ? " with error: " + ff.error : ""}` : ""; const b = $("#c-full"); if (b) b.disabled = ff.running; }
    const cnt = (st, status) => (j.counts.find((x) => x.stage === st && x.status === status) || { n: 0 }).n;
    $("#c-sched").innerHTML = s.schedulers.map((x) => {
      const st = x.last_error ? "err" : x.busy ? "busy" : x.running ? "on" : "off";
      const lane = x.name === "SIM"
        ? `<div class="lane" style="grid-template-columns:1fr 1fr"><div class="d"><b>${s.sim.cursor}</b><span>events played</span></div><div class="p"><b>${s.sim.total - s.sim.cursor}</b><span>remaining</span></div></div>`
        : `<div class="lane"><div class="p"><b>${cnt(x.name, "pending")}</b><span>before</span></div><div class="r"><b>${cnt(x.name, "processing")}</b><span>processing</span></div><div class="d"><b>${cnt(x.name, "done")}</b><span>done</span></div><div class="f"><b>${cnt(x.name, "failed")}</b><span>failed</span></div></div>`;
      return `<div class="sched"><div class="sched-h"><b>${esc(x.label)}</b><span class="pill ${st}"><i></i>${x.busy ? "working" : x.running ? "running" : "stopped"}</span></div>
        <div class="meta">Every ${x.interval_sec}s · ${x.runs} run(s) · last ${x.last ? fmtT(x.last.at) + (x.last.note ? " · " + esc(x.last.note) : "") : "never"}${x.last_error ? `<br><span style="color:var(--bad)">${esc(x.last_error)}</span>` : ""}</div>
        ${lane}
        <div class="row"><button class="btn sm ${x.running ? "" : "primary"}" data-a="${x.running ? "stop" : "start"}" data-s="${x.name}">${x.running ? "Stop" : "Start"}</button><button class="btn sm" data-a="run" data-s="${x.name}">Run once</button>
        <a class="small" href="#/jobs">${x.name === "SIM" ? "" : "Open job monitor"}</a></div></div>`;
    }).join("");
    $$("#c-sched [data-a]").forEach((b) => (b.onclick = async () => { b.disabled = true; await post(`/api/scheduler/${b.dataset.s}/${b.dataset.a}`); refreshStatus(); this.refresh(); }));
  },
});

// ---------------- jobs ----------------
const jobFilter = { stage: "", status: "" };
let seenJob = 0;
route("jobs", {
  title: "Job monitor",
  async render() {
    view.innerHTML = `<div class="head"><div><h1>Job monitor</h1><p>Every change found by L1 becomes a job: <b>before</b> (pending) → <b>processing</b> → <b>done</b> or <b>failed</b>. Click a job to see its input, output and log lines.</p></div></div>
      <div class="grid g2" id="j-lanes"></div>
      <div class="card"><div class="row" style="margin-bottom:10px">
        <select id="j-stage"><option value="">All stages</option><option>L1</option><option>L2</option></select>
        <select id="j-status"><option value="">All states</option><option value="pending">before (pending)</option><option>processing</option><option>done</option><option>failed</option></select>
        <span class="small muted">Newest 200 shown · live</span></div><div class="tbl-wrap" id="j-table"></div></div>`;
    $("#j-stage").value = jobFilter.stage; $("#j-status").value = jobFilter.status;
    $("#j-stage").onchange = (e) => { jobFilter.stage = e.target.value; this.refresh(); };
    $("#j-status").onchange = (e) => { jobFilter.status = e.target.value; this.refresh(); };
  },
  async refresh() {
    const p = new URLSearchParams(Object.entries(jobFilter).filter(([, v]) => v));
    const j = await api(`/api/jobs?${p}`);
    const cnt = (st, s) => (j.counts.find((x) => x.stage === st && x.status === s) || { n: 0 }).n;
    $("#j-lanes").innerHTML = ["L1", "L2"].map((st) => `<div class="card"><h3>${st === "L1" ? "L1 · Normalize" : "L2 · Cards & links"}</h3><div class="lane">
      <div class="p"><b>${cnt(st, "pending")}</b><span>before</span></div><div class="r"><b>${cnt(st, "processing")}</b><span>processing</span></div><div class="d"><b>${cnt(st, "done")}</b><span>done</span></div><div class="f"><b>${cnt(st, "failed")}</b><span>failed</span></div></div></div>`).join("");
    const maxSeen = seenJob;
    $("#j-table").innerHTML = j.rows.length ? `<table><thead><tr><th>Job</th><th>Stage</th><th>Kind</th><th>Item</th><th>Ticket</th><th>State</th><th>Created</th><th>Finished</th></tr></thead><tbody>
      ${j.rows.map((r) => `<tr class="click ${r.id > maxSeen && maxSeen ? "new" : ""}" data-id="${r.id}"><td class="mono">#${r.id}</td><td>${r.stage}</td><td>${r.kind}</td><td class="mono small">${esc(r.ref)}</td><td>${r.task ? `<a href="#/ticket/${r.task}">${r.task}</a>` : ""}</td><td>${tag(r.status === "pending" ? "before" : r.status, r.status)}</td><td>${fmtT(r.created_at)}</td><td>${fmtT(r.finished_at)}</td></tr>`).join("")}</tbody></table>`
      : `<div class="empty">No jobs yet. Start the simulator and L1 on the Control page.</div>`;
    seenJob = Math.max(seenJob, ...j.rows.map((r) => Number(r.id)), 0);
    $$("#j-table tr[data-id]").forEach((tr) => (tr.onclick = (e) => { if (e.target.tagName !== "A") showJob(tr.dataset.id); }));
  },
});
async function showJob(id) {
  const { job, logs } = await api(`/api/jobs/${id}`);
  drawer(`<h2>Job #${job.id} · ${esc(job.stage)} ${esc(job.kind)}</h2>
    <div class="row">${tag(job.status)} <span class="mono small">${esc(job.ref)}</span> ${job.task ? `<a href="#/ticket/${job.task}">${job.task}</a>` : ""}</div>
    <dl class="kv"><dt>Created</dt><dd>${fmtD(job.created_at)} ${fmtT(job.created_at)}</dd><dt>Started</dt><dd>${fmtT(job.started_at)}</dd><dt>Finished</dt><dd>${fmtT(job.finished_at)}</dd><dt>Attempts</dt><dd>${job.attempts}</dd><dt>Run</dt><dd>${job.run_id ? "#" + job.run_id : "—"}</dd></dl>
    <div class="ba"><div><h4>Before</h4><pre class="json">${esc(JSON.stringify(job.before, null, 2) || "—")}</pre></div><div><h4>After</h4><pre class="json">${esc(JSON.stringify(job.after, null, 2) || "—")}</pre></div></div>
    ${job.error ? `<div><h4 class="muted">Error</h4><pre class="json" style="color:var(--bad)">${esc(job.error)}</pre><button class="btn sm" id="retry">Retry job</button></div>` : ""}
    <h3>Log lines</h3>${logTable(logs)}`);
  const r = $("#retry"); if (r) r.onclick = async () => { await post(`/api/jobs/${id}/retry`); toast("Job queued again"); $("#drawer").hidden = true; };
}

// ---------------- logs ----------------
const logFilter = { level: "", stage: "", task: "", text: "" };
route("logs", {
  title: "Logs",
  async render() {
    const qp = new URLSearchParams(location.hash.split("?")[1] || "");
    if (qp.get("level")) logFilter.level = qp.get("level");
    view.innerHTML = `<div class="head"><div><h1>Logs</h1><p>Structured logs from the simulator, L1, L2, L3 indexing and admin actions. Live tail, newest first.</p></div></div>
      <div class="card"><div class="row" style="margin-bottom:10px">
        <select id="l-level"><option value="">All levels</option><option value="info,warn,error">info and above</option><option value="warn,error">warn and above</option><option value="error">error</option></select>
        <select id="l-stage"><option value="">All sources</option><option>SIM</option><option>L1</option><option>L2</option><option>L3</option><option>ADMIN</option></select>
        <input id="l-task" placeholder="Ticket e.g. 118256-01" size="18"><input id="l-text" placeholder="Text contains…" size="22">
        <label class="small"><input type="checkbox" id="l-live" checked> Live</label></div><div class="tbl-wrap" id="l-table"></div></div>`;
    for (const k of ["level", "stage", "task", "text"]) {
      const el = $(`#l-${k}`); el.value = logFilter[k];
      el.oninput = () => { logFilter[k] = el.value; this.refresh(true); };
    }
  },
  async refresh(force) {
    if (!force && !$("#l-live").checked) return;
    const p = new URLSearchParams(Object.entries(logFilter).filter(([, v]) => v));
    $("#l-table").innerHTML = logTable(await api(`/api/logs?${p}`), true);
    $$("#l-table [data-task]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); showTrace(a.dataset.task); }));
  },
});
function logTable(rows, withTask) {
  if (!rows.length) return `<div class="empty">No log lines match.</div>`;
  const lv = { info: "info", warn: "warn", error: "error", debug: "debug" };
  return `<table class="log"><thead><tr><th>Time</th><th class="lv">Level</th><th>Source</th>${withTask ? "<th>Ticket</th>" : ""}<th>Message</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${fmtT(r.ts)}</td><td>${tag(r.level, lv[r.level])}</td><td>${esc(r.stage)}${r.run_id ? `<span class="muted"> #${r.run_id}</span>` : ""}</td>${withTask ? `<td>${r.task ? `<a href="#" data-task="${r.task}">${r.task}</a>` : ""}</td>` : ""}<td>${esc(r.message)}</td></tr>`).join("")}</tbody></table>`;
}
async function showTrace(task) {
  const t = await api(`/api/trace/${task}`);
  drawer(`<h2>Trace · ${esc(task)}</h2><p class="small muted">Everything that happened to this ticket across the simulator, L1, L2 and the index.</p>
    <a href="#/ticket/${task}">Open ticket page</a><h3>Jobs</h3>
    <table><thead><tr><th>Job</th><th>Stage</th><th>Kind</th><th>State</th><th>Finished</th></tr></thead><tbody>${t.jobs.map((j) => `<tr><td>#${j.id}</td><td>${j.stage}</td><td>${j.kind}</td><td>${tag(j.status)}</td><td>${fmtT(j.finished_at)}</td></tr>`).join("")}</tbody></table>
    <h3>Log</h3>${logTable(t.logs)}`);
}

// ---------------- runs ----------------
route("runs", {
  title: "Run history",
  async render() {
    view.innerHTML = `<div class="head"><div><h1>Run history</h1><p>One row per scheduler run: what it picked up, finished and failed, and how long it took.</p></div>
      <select id="r-s"><option value="">All schedulers</option><option>SIM</option><option>L1</option><option>L2</option></select></div><div class="card tbl-wrap" id="r-table"></div>`;
    $("#r-s").onchange = () => this.refresh();
  },
  async refresh() {
    const s = $("#r-s").value;
    const rows = await api(`/api/runs${s ? "?scheduler=" + s : ""}`);
    $("#r-table").innerHTML = rows.length ? `<table><thead><tr><th>Run</th><th>Scheduler</th><th>Trigger</th><th>Status</th><th>Started</th><th class="num">Seconds</th><th class="num">Picked</th><th class="num">Done</th><th class="num">Failed</th><th>Note</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="mono">#${r.id}</td><td>${r.scheduler}</td><td>${r.trigger}</td><td>${tag(r.status)}</td><td>${fmtD(r.started_at)} ${fmtT(r.started_at)}</td><td class="num">${r.secs != null ? Number(r.secs).toFixed(1) : "—"}</td><td class="num">${r.picked}</td><td class="num">${r.done}</td><td class="num">${r.failed}</td><td class="small muted">${esc(r.note || "")}</td></tr>`).join("")}</tbody></table>`
      : `<div class="empty">No runs yet.</div>`;
  },
});

// ---------------- review ----------------
route("review", {
  title: "Review queue",
  async render() {
    view.innerHTML = `<div class="head"><div><h1>Review queue</h1><p>What the machine is unsure about: inferred CR↔code links, plug-and-play copies, possible duplicates and commits with no CR. Approving an inferred link makes it <b>strong · confirmed by expert</b> and regenerates the card.</p></div>
      <div class="tabs" id="rv-tabs"><button data-s="open" class="on">Open</button><button data-s="approved">Approved</button><button data-s="rejected">Rejected</button></div></div><div id="rv-list"></div>`;
    this.status = "open";
    $$("#rv-tabs button").forEach((b) => (b.onclick = () => { $$("#rv-tabs button").forEach((x) => x.classList.toggle("on", x === b)); this.status = b.dataset.s; this.load(); }));
    await this.load();
  },
  async load() {
    const rows = await api(`/api/review?status=${this.status}`);
    const label = { inferred_link: "Inferred link", clone: "Plug-and-play copy", duplicate: "Possible duplicate", unlinked: "No CR found" };
    $("#rv-list").innerHTML = rows.length ? rows.map((r) => `<div class="card"><h3><span>${tag(label[r.kind] || r.kind, r.kind === "duplicate" ? "strong" : "inferred")} ${esc(r.title)}</span>${r.status === "open" ? `<span class="row"><button class="btn sm primary" data-d="approve" data-id="${r.id}">${r.kind === "duplicate" ? "Confirm duplicate" : r.kind === "unlinked" ? "Acknowledge" : "Approve link"}</button><button class="btn sm" data-d="reject" data-id="${r.id}">Reject</button></span>` : tag(r.status)}</h3>
      <div class="small">${r.task && r.kind !== "duplicate" ? `Ticket <a href="#/ticket/${r.task}">${r.task}</a> · ` : ""}${r.detail.repo ? `Repo <a href="#/repo/${esc(r.detail.repo)}">${esc(r.detail.repo)}</a> · commit <span class="mono">${esc((r.detail.commit || "").slice(0, 7))}</span> “${esc(r.detail.message || "")}”` : ""}${r.kind === "duplicate" ? `<a href="#/ticket/${r.detail.a}">${r.detail.a}</a> ${esc(r.detail.a_title)} ↔ <a href="#/ticket/${r.detail.b}">${r.detail.b}</a> ${esc(r.detail.b_title)} · similarity ${Number(r.detail.score).toFixed(2)}` : ""}</div>
      ${r.detail.evidence ? `<p class="small muted" style="margin:6px 0 0">Evidence: ${esc(r.detail.evidence)}</p>` : ""}</div>`).join("")
      : `<div class="empty">No ${this.status} items.</div>`;
    $$("#rv-list [data-d]").forEach((b) => (b.onclick = async () => { b.disabled = true; await post(`/api/review/${b.dataset.id}`, { decision: b.dataset.d }); toast(b.dataset.d === "approve" ? "Approved. The card will be regenerated by L2." : "Rejected."); refreshStatus(); this.load(); }));
  },
});

// ---------------- portal: search ----------------
let lastQuery = "";
route("search", {
  title: "Search",
  async render() {
    view.innerHTML = `<div class="head"><div><h1>Search the knowledge base</h1><p>Search cards, attachments and code. Type a ticket number (e.g. <code>118256-02</code>) or CR family (<code>118256</code>) to jump straight to it. Code copies are collapsed into one result per clone group.</p></div></div>
      <form class="searchbox" id="s-form"><input id="s-q" placeholder="e.g. reprint supervisor badge, tray serial, MAX_REPRINT" value="${esc(lastQuery)}" autofocus><select id="s-site"><option value="">All sites</option>${["PEN", "SZH", "BKK", "GDL", "AUS", "TIJ"].map((s) => `<option>${s}</option>`).join("")}</select><button class="btn primary">Search</button></form>
      <div class="row small muted">Try: <a href="#" data-q="label reprint">label reprint</a> · <a href="#" data-q="moisture floor life">moisture floor life</a> · <a href="#" data-q="audit log">audit log</a> · <a href="#" data-q="check tray serial">check tray serial (code)</a></div>
      <div id="s-res"></div>`;
    $("#s-form").onsubmit = (e) => { e.preventDefault(); this.search(); };
    $$("[data-q]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); $("#s-q").value = a.dataset.q; this.search(); }));
    if (lastQuery) this.search();
  },
  async search() {
    lastQuery = $("#s-q").value.trim();
    if (!lastQuery) return;
    const r = await api(`/api/search?q=${encodeURIComponent(lastQuery)}${$("#s-site").value ? "&site=" + $("#s-site").value : ""}`);
    if (r.jump) { location.hash = r.jump; return; }
    const { cards, docs, code } = r.results;
    $("#s-res").innerHTML = `<div class="grid g2" style="align-items:start">
      <div class="card"><h3>Knowledge cards <span class="small muted">${cards.length}</span></h3>${cards.map((c) => `<div class="hit"><div class="t"><a href="#/ticket/${c.task}">${c.task}</a> ${esc(c.title)}</div><div class="small">${tag(c.link_confidence)} ${esc(c.site)} · ${esc(c.state)}</div><div class="small snippet">${c.snippet}</div></div>`).join("") || `<div class="muted small">No cards match.</div>`}</div>
      <div class="grid"><div class="card"><h3>Code <span class="small muted">${code.length} (copies collapsed)</span></h3>${code.map((u) => `<div class="hit"><div class="t mono"><a href="#/code/${u.id}">${esc(u.name)}</a></div><div class="small">${esc(u.repo)}/${esc(u.path)} · ${u.lang}${u.copies > 0 ? ` · ${tag(`+${u.copies} cop${u.copies > 1 ? "ies" : "y"} in clone group CG-${String(u.group_id).padStart(4, "0")}`, "inferred")}` : ""}</div>${u.doc ? `<div class="small muted">${esc(u.doc)}</div>` : ""}</div>`).join("") || `<div class="muted small">No code matches.</div>`}</div>
      <div class="card"><h3>Attachments <span class="small muted">${docs.length}</span></h3>${docs.map((d) => `<div class="hit"><div class="t"><a href="#/ticket/${d.task}">${d.task}</a> ${esc(d.file_name)} ${tag(d.format, "unlinked")}</div><div class="small snippet">${d.snippet}</div></div>`).join("") || `<div class="muted small">No attachments match.</div>`}</div></div></div>`;
  },
});

// ---------------- portal: tickets, sites ----------------
route("tickets", {
  title: "Tickets",
  async render() {
    view.innerHTML = `<div class="head"><div><h1>Tickets</h1><p>Every FlexPM task revision in the knowledge base, with its card and link confidence.</p></div>
      <div class="row"><select id="t-site"><option value="">All sites</option>${["PEN", "SZH", "BKK", "GDL", "AUS", "TIJ"].map((s) => `<option>${s}</option>`).join("")}</select>
      <select id="t-conf"><option value="">Any confidence</option><option>confirmed</option><option>strong</option><option>inferred</option><option>unlinked</option></select></div></div>
      <div class="card tbl-wrap" id="t-table"></div>`;
    $("#t-site").onchange = $("#t-conf").onchange = () => this.load();
    await this.load();
  },
  async load() {
    const p = new URLSearchParams(); if ($("#t-site").value) p.set("site", $("#t-site").value); if ($("#t-conf").value) p.set("confidence", $("#t-conf").value);
    const rows = await api(`/api/tickets?${p}`);
    $("#t-table").innerHTML = rows.length ? `<table><thead><tr><th>Ticket</th><th>Title</th><th>Site</th><th>State</th><th>Created</th><th class="num">Edits</th><th>Card</th><th>Link confidence</th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="click" onclick="location.hash='#/ticket/${r.task}'"><td class="mono">${r.task}</td><td>${esc(r.title)}</td><td>${r.site}</td><td class="small">${esc(r.state)}</td><td>${fmtD(r.created)}</td><td class="num">${r.edit_no}</td><td>${r.version ? "v" + r.version : "—"}</td><td>${r.link_confidence ? tag(r.link_confidence) : "—"}</td></tr>`).join("")}</tbody></table>`
      : `<div class="empty">No tickets yet. Start the schedulers.</div>`;
  },
});
route("sites", {
  title: "Sites",
  async render() {
    const rows = await api("/api/sites");
    view.innerHTML = `<div class="head"><div><h1>Sites</h1><p>Which sites have which functions, built from the link database.</p></div></div>
      <div class="card tbl-wrap">${rows.length ? `<table><thead><tr><th>Site</th><th>Region</th><th>Customer</th><th class="num">Tickets</th><th class="num">Capabilities</th><th class="num">Tickets with linked code</th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="click" onclick="location.hash='#/site/${r.site}'"><td><b>${r.site}</b></td><td>${r.region}</td><td>${r.customer}</td><td class="num">${r.tickets}</td><td class="num">${r.capabilities}</td><td class="num">${r.linked}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">No data yet.</div>`}</div>`;
  },
});
route("site", {
  title: "Site", nav: "sites", crumb: (a) => `Sites / ${a[0]}`,
  async render([site]) {
    const rows = await api(`/api/site/${site}`);
    const byCap = {};
    rows.forEach((r) => (byCap[r.capability] = byCap[r.capability] || []).push(r));
    view.innerHTML = `<div class="head"><div><h1>Site ${esc(site)}</h1><p>${rows.length} ticket(s) across ${Object.keys(byCap).length} capabilities.</p></div></div>
      <div class="grid g2">${Object.entries(byCap).map(([cap, list]) => `<div class="card"><h3>${esc(cap.replace(/_/g, " "))}</h3>${list.map((r) => `<div class="small"><a href="#/ticket/${r.task}">${r.task}</a> ${esc(r.title)} ${r.link_confidence ? tag(r.link_confidence) : ""}</div>`).join("")}</div>`).join("")}</div>`;
  },
});

// ---------------- portal: ticket page ----------------
route("ticket", {
  title: "Ticket", nav: "tickets", crumb: (a) => `Tickets / ${a[0]}`,
  async render([task]) {
    const d = await api(`/api/ticket/${task}`);
    const t = d.ticket;
    const c = d.card;
    view.innerHTML = `
      <div class="head"><div><div class="small muted mono">CR family <a href="#/family/${t.cr}">${t.cr}</a> · revision ${String(t.rev).padStart(2, "0")}</div><h1>${esc(t.task)} ${esc(t.title)}</h1>
        <div class="row" style="margin-top:6px">${c ? tag(c.link_confidence) : tag("no card yet", "unlinked")} ${tag(t.state, "unlinked")} ${c ? `<span class="small muted">Card v${c.version} · ${esc(c.status)} · ${esc(c.model)} · template ${esc(c.template_version)}</span>` : ""}</div></div>
        <button class="btn" id="tk-trace">Show pipeline trace</button></div>
      <div class="layout-ticket">
        <div class="card"><div class="tabs" id="tk-tabs"><button data-t="card" class="on">Knowledge card</button><button data-t="sources">Sources (${d.documents.length})</button><button data-t="links">Code &amp; links (${d.links.length})</button><button data-t="history">History</button></div><div id="tk-body"></div></div>
        <div class="grid">
          <div class="card"><h3>FlexPM fields</h3><dl class="kv"><dt>Project</dt><dd>${esc(t.project)}</dd><dt>Site</dt><dd><a href="#/site/${t.site}">${t.site}</a> · ${esc(t.region)}</dd><dt>Customer</dt><dd>${esc(t.customer)}</dd><dt>Owner</dt><dd>${esc(t.owner)}</dd><dt>Priority</dt><dd>${esc(t.priority)}</dd><dt>Created</dt><dd>${fmtD(t.created)}</dd><dt>Required</dt><dd>${fmtD(t.required)}</dd><dt>Edits</dt><dd>${t.edit_no}</dd></dl></div>
          <div class="card"><h3>Revision chain</h3>${d.family.map((f) => `<div class="small">${f.task === t.task ? `<b>${f.task}</b>` : `<a href="#/ticket/${f.task}">${f.task}</a>`} ${esc(f.title)} <span class="muted">${esc(f.state)}</span></div>`).join("")}</div>
          <div class="card"><h3>Similar tickets at other sites</h3>${d.similar.length ? d.similar.map((s) => `<div class="small"><a href="#/ticket/${s.task}">${s.task}</a> ${esc(s.title)} <span class="muted">${s.site} · ${Number(s.score).toFixed(2)}</span></div>`).join("") : `<span class="small muted">None above the threshold.</span>`}</div>
          ${d.review.length ? `<div class="card"><h3>Review items</h3>${d.review.map((r) => `<div class="small">${tag(r.status)} <a href="#/review">${esc(r.title)}</a></div>`).join("")}</div>` : ""}
        </div></div>`;
    $("#tk-trace").onclick = () => showTrace(task);
    const tabs = {
      card: () => (c ? renderCard(c.card_md) : `<div class="empty">L2 has not written a card for this ticket yet.</div>`),
      sources: () => `<p class="small muted">Original ticket text and attachments as extracted to Markdown by L1.</p><h3>Ticket description</h3><pre class="json">${esc(t.body_md)}</pre>` +
        d.documents.map((x) => `<h3 style="margin-top:12px">${esc(x.file_name)} ${tag(x.format, "unlinked")} <span class="small muted">${x.chars} chars</span></h3><pre class="json">${esc(x.markdown)}</pre>`).join(""),
      links: () => d.links.length ? `<table><thead><tr><th>Tier</th><th>Repo</th><th>Commit</th><th>Evidence</th></tr></thead><tbody>${d.links.map((l) => `<tr><td>${tag(l.tier)} ${l.source === "expert" ? tag("expert") : ""} ${l.status === "rejected" ? tag("rejected") : ""}</td><td><a href="#/repo/${esc(l.repo)}">${esc(l.repo)}</a></td><td class="mono small">${esc((l.commit_sha || "").slice(0, 7))}<br><span class="muted">${fmtD(l.committed_at)} ${esc(l.author || "")}</span></td><td class="small">${esc(l.evidence)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">No code linked. ${/NOT IMPLEMENTED|LEAD APPROVAL/.test(t.state) ? "The ticket is not implemented yet." : "This is a knowledge gap: check the review queue."}</div>`,
      history: () => `<h3>Ticket edits (kept, never overwritten)</h3><table><thead><tr><th>Edit</th><th>Captured</th><th>State</th><th>Required</th></tr></thead><tbody>${d.versions.map((v) => `<tr><td>#${v.edit_no}</td><td>${fmtD(v.captured_at)} ${fmtT(v.captured_at)}</td><td>${esc(v.state)}</td><td>${esc(v.required)}</td></tr>`).join("")}</tbody></table>
        <h3 style="margin-top:14px">Card versions</h3><table><thead><tr><th>Version</th><th>Model</th><th>Generated</th></tr></thead><tbody>${d.card_versions.map((v) => `<tr><td>v${v.version}</td><td>${esc(v.model)}</td><td>${fmtD(v.generated_at)} ${fmtT(v.generated_at)}</td></tr>`).join("")}</tbody></table>`,
    };
    const show = (k) => { $$("#tk-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === k)); $("#tk-body").innerHTML = tabs[k](); };
    $$("#tk-tabs button").forEach((b) => (b.onclick = () => show(b.dataset.t)));
    show("card");
  },
});
function renderCard(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  const fm = m ? m[1].split("\n").map((l) => l.split(/:\s(.*)/s)).filter((x) => x[1]) : [];
  const body = m ? md.slice(m[0].length) : md;
  const html = window.marked ? marked.parse(body) : `<pre>${esc(body)}</pre>`;
  return `<details class="small" style="margin-bottom:8px"><summary class="muted">Front-matter (${fm.length} fields)</summary><dl class="kv" style="margin-top:6px">${fm.map(([k, v]) => `<dt class="mono">${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></details>
    <div class="md">${html.replace(/\[((?:T|A|C)\d+)\]/g, '<span class="src">$1</span>')}</div>`;
}

route("family", {
  title: "CR family", nav: "tickets", crumb: (a) => `CR family / ${a[0]}`,
  async render([cr]) {
    const d = await api(`/api/family/${cr}`);
    view.innerHTML = `<div class="head"><div><h1>CR family ${esc(cr)}</h1><p>${d.tickets.length} revision(s). Each revision is newer functionality and may serve a different project.</p></div></div>
      ${d.tickets.map((t) => `<div class="card"><h3><span><a href="#/ticket/${t.task}">${t.task}</a> ${esc(t.title)}</span>${t.link_confidence ? tag(t.link_confidence) : ""}</h3><div class="small muted">${esc(t.project)} · ${esc(t.state)} · created ${fmtD(t.created)}</div><div class="md small">${t.overview ? marked.parse(t.overview).replace(/\[((?:T|A|C)\d+)\]/g, '<span class="src">$1</span>') : "No card yet."}</div></div>`).join("")}`;
  },
});
route("repo", {
  title: "Repository", nav: "tickets", crumb: (a) => `Repositories / ${a[0]}`,
  async render([name]) {
    const d = await api(`/api/repo/${encodeURIComponent(name)}`);
    view.innerHTML = `<div class="head"><div><h1 class="mono" style="font-size:22px">${esc(name)}</h1><p>${/FLEXPM\d+/.test(name) ? "Named with the FLEXPM convention, so the CR link is confirmed by the repo name." : "Legacy repository without a CR in its name. Links come from commit messages, code similarity or text similarity."}</p></div></div>
      <div class="grid g2" style="align-items:start">
        <div class="card"><h3>Commits</h3><table><thead><tr><th>Commit</th><th>Message</th><th>Linked to</th></tr></thead><tbody>${d.commits.map((c) => `<tr><td class="mono small">${c.sha.slice(0, 7)}<br><span class="muted">${fmtD(c.committed_at)} ${esc(c.author)}</span></td><td class="small">${esc(c.message)}</td><td>${(c.links || []).map((l) => `<a href="#/ticket/${l.task}">${l.task}</a> ${tag(l.tier)}`).join("<br>") || tag("unlinked")}</td></tr>`).join("")}</tbody></table></div>
        <div class="card"><h3>Code units</h3><table><thead><tr><th>Unit</th><th>Lines</th><th>Clone group</th></tr></thead><tbody>${d.units.map((u) => `<tr><td><a class="mono" href="#/code/${u.id}">${esc(u.name)}</a><br><span class="small muted">${esc(u.path)}</span></td><td class="small">${u.start_line}-${u.end_line}</td><td class="small">${u.group_id ? `CG-${String(u.group_id).padStart(4, "0")} ${tag(u.role, u.role === "origin" ? "confirmed" : "inferred")}` : "—"}</td></tr>`).join("")}</tbody></table></div></div>`;
  },
});
route("code", {
  title: "Code", nav: "search", crumb: () => "Code unit",
  async render([id]) {
    const d = await api(`/api/code/${id}`);
    const u = d.unit;
    view.innerHTML = `<div class="head"><div><div class="small muted"><a href="#/repo/${esc(u.repo)}">${esc(u.repo)}</a> / ${esc(u.path)} · lines ${u.start_line}-${u.end_line} · commit <span class="mono">${esc((u.commit_sha || "").slice(0, 7))}</span></div><h1 class="mono" style="font-size:22px">${esc(u.name)}</h1></div></div>
      <div class="layout-ticket"><div class="card"><pre class="code">${esc(u.body)}</pre></div>
      <div class="grid"><div class="card"><h3>Requirement (code → CR)</h3>${d.links.length ? d.links.map((l) => `<div class="small"><a href="#/ticket/${l.task}">${l.task}</a> ${tag(l.tier)}</div>`).join("") : `<span class="small muted">No CR linked to this repository.</span>`}</div>
      <div class="card"><h3>Copies and variants</h3>${d.group.length ? d.group.map((g) => `<div class="small">${g.unit_id === u.id ? "<b>this</b>" : `<a href="#/code/${g.unit_id}">${esc(g.repo)}/${esc(g.path)}</a>`} ${tag(g.role, g.role === "origin" ? "confirmed" : "inferred")} ${g.role === "variant" ? Number(g.similarity).toFixed(2) : ""}</div>`).join("") : `<span class="small muted">Not part of any clone group.</span>`}</div></div></div>`;
  },
});

refreshStatus().then(go);
