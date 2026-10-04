// Engineer portal: Ask, Search, Functions (capabilities), Check before you build, Code → requirement, ticket pages.
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtD = (t) => (t ? new Date(t).toISOString().slice(0, 10) : "—");
const tag = (v) => `<span class="tag ${esc(v || "none")}">${esc(v || "no card")}</span>`;
const view = $("#view");
const md = (s) => (window.marked ? marked.parse(s) : `<pre>${esc(s)}</pre>`);

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
const post = (p, b) => api(p, { method: "POST", body: JSON.stringify(b || {}) });
function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500); }

// ---------------- router ----------------
const routes = {};
const route = (n, f) => (routes[n] = f);
function parseHash() {
  const [p, qs] = location.hash.replace(/^#\/?/, "").split("?");
  const [name = "", ...args] = p.split("/").map(decodeURIComponent);
  return { name, args, params: new URLSearchParams(qs || "") };
}
async function go() {
  const { name, args, params } = parseHash();
  const r = routes[name] || routes[""];
  $$(".bar nav a").forEach((a) => a.classList.toggle("on", a.dataset.nav === (r.nav || name)));
  view.innerHTML = `<div class="thinking"><i></i>Loading…</div>`;
  try { await r(args, params); } catch (e) { view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  if (!params.get("keep")) window.scrollTo(0, 0);
}
window.addEventListener("hashchange", go);

const EXAMPLES = [
  "What does 128605-01 do?",
  "Which sites have label reprint control?",
  "Why was the reprint limit added?",
  "Where is the code for tray serial check?",
  "Which sites have moisture tracking for MSL reels?",
  "Why do we check solder paste open time?",
  "What was developed for customer LUMEN?",
  "Which functions are about traceability?",
];

// ---------------- home ----------------
route("", async () => {
  const d = await api("/api/home");
  view.innerHTML = `
    <section class="hero">
      <h1>Find any shopfloor function, why it was built, and where it runs.</h1>
      <p>One place for MyPM change requests and the code that implemented them, across every site.</p>
      ${askBox("")}
      <div class="stat"><span><b>${d.counts.capabilities}</b>functions</span><span><b>${d.counts.sites}</b>sites</span><span><b>${d.counts.cards}</b>knowledge cards</span><span><b>${d.counts.units}</b>code functions indexed</span></div>
    </section>
    <div class="grid g3">
      <a class="panel feature" href="#/ask"><b>Ask a question</b><span>Get an answer with citations to tickets, documents and code. List questions are answered completely from the link database.</span><span class="go">Ask →</span></a>
      <a class="panel feature" href="#/check"><b>Check before you build</b><span>Paste a new requirement and see whether the same function already exists at another site.</span><span class="go">Check a requirement →</span></a>
      <a class="panel feature" href="#/code"><b>Code → requirement</b><span>Pick any line of code and see the commit, the change request and why it was built.</span><span class="go">Open code lookup →</span></a>
    </div>
    <section class="grid"><div class="row-h"><h2>Functions across sites</h2></div>
      ${d.capabilities.length ? `<div class="caps">${d.capabilities.slice(0, 9).map(capTile).join("")}</div><a href="#/capabilities">All ${d.capabilities.length} functions →</a>` : `<div class="empty">The knowledge base is empty. Start the pipeline from the <a href="/ops/">Ops console</a>.</div>`}
    </section>
    <section class="grid g2">
      <div class="panel"><h3>Recently updated knowledge</h3>${d.recent.map((r) => `<div class="hit"><a href="#/ticket/${r.task}"><b>${r.task}</b> ${esc(r.title)}</a><span class="tiny muted">${r.site} · card v${r.version} · ${fmtD(r.generated_at)} ${tag(r.link_confidence)}</span></div>`).join("") || `<span class="muted">Nothing yet.</span>`}</div>
      <div class="panel"><h3>Sites</h3><div class="grid">${d.sites.map((s) => `<div class="small"><span class="site">${s.site}</span> ${esc(s.customer)} · ${s.region} · ${s.n} tickets</div>`).join("") || `<span class="muted">Nothing yet.</span>`}</div></div>
    </section>`;
  bindAskBox();
});
const tagChips = (tags) => (tags && tags.length ? `<div class="sites">${tags.map((t) => `<span class="ftag">${esc(t)}</span>`).join("")}</div>` : "");
const capTile = (c) => `<a class="cap" href="#/capability/${c.k}"><b>${esc(c.title)}</b><span class="why">${esc(c.why ? c.why.charAt(0).toUpperCase() + c.why.slice(1) + "." : "")}</span>${tagChips(c.tags)}<div class="sites">${c.site_list.map((s) => `<span class="site">${s}</span>`).join("")}</div><span class="tiny muted">${c.tickets} ticket(s)</span></a>`;

function askBox(value, mode = "ask") {
  return `<form class="askbox" id="askbox">
    <div class="askbox-row"><div class="mode" role="group" aria-label="Mode"><button type="button" data-m="ask" aria-pressed="${mode === "ask"}">Ask</button><button type="button" data-m="search" aria-pressed="${mode === "search"}">Search</button></div>
      <input id="ab-q" value="${esc(value)}" placeholder="${mode === "ask" ? "Ask, e.g. Which sites have label reprint control?" : "Search tickets, documents and code, or type a ticket number"}" aria-label="Question or search">
      <button class="btn primary">${mode === "ask" ? "Ask" : "Search"}</button></div>
    <div class="chips">${EXAMPLES.map((e) => `<button type="button" class="chip" data-ex="${esc(e)}">${esc(e)}</button>`).join("")}</div></form>`;
}
function bindAskBox() {
  const f = $("#askbox"); if (!f) return;
  let mode = $$("#askbox [data-m]").find((b) => b.getAttribute("aria-pressed") === "true").dataset.m;
  $$("#askbox [data-m]").forEach((b) => (b.onclick = () => { mode = b.dataset.m; $$("#askbox [data-m]").forEach((x) => x.setAttribute("aria-pressed", x === b)); f.querySelector(".btn").textContent = mode === "ask" ? "Ask" : "Search"; $("#ab-q").focus(); }));
  $$("#askbox [data-ex]").forEach((c) => (c.onclick = () => { location.hash = `#/ask?q=${encodeURIComponent(c.dataset.ex)}`; }));
  f.onsubmit = (e) => { e.preventDefault(); const v = $("#ab-q").value.trim(); if (v) location.hash = `#/${mode}?q=${encodeURIComponent(v)}`; };
}

// ---------------- ask ----------------
route("ask", async (args, params) => {
  const qtext = params.get("q") || "";
  view.innerHTML = `<div><h1>Ask</h1><p class="lede">Answers come only from the knowledge base and show their sources. "Which sites" questions are answered from the link database, so the list is complete within known links.</p></div>${askBox(qtext)}<div id="ans"></div>`;
  bindAskBox();
  if (!qtext) return;
  $("#ans").innerHTML = `<div class="panel thinking"><i></i>Looking through cards, the link database and code…</div>`;
  const a = await post("/api/ask", { q: qtext });
  const html = md(a.answer).replace(/\[(\d+)\]/g, (_, n) => `<sup class="c"><a href="#src-${n}" data-src="${n}">${n}</a></sup>`);
  $("#ans").innerHTML = `
    <div class="grid side">
      <div class="panel"><div class="tiny muted" style="margin-bottom:6px">${a.type === "list" ? "List question · answered from the link database" : a.type === "code" ? "Code question" : a.type === "ticket" ? "Ticket question · answered from its knowledge card" : "Explanation · answered from knowledge cards"} · ${a.mode === "grounded" ? "grounded answer (no model)" : "written by " + esc(a.mode)}</div>
        <div class="answer">${html}</div>
        ${a.capability ? `<p class="small"><a href="#/capability/${a.capability}">Open the ${esc(a.capability_title)} page →</a></p>` : ""}
        <div class="fb" style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px"><span class="small muted">Was this helpful?</span>
          <button class="btn sm" data-fb="up">👍 Yes</button><button class="btn sm" data-fb="down">👎 No</button>
          <input id="fb-note" placeholder="Optional: what was wrong or missing?"></div></div>
      <div class="grid">
        <div class="panel"><h3>Sources</h3><ol class="sources">${a.sources.map((s, i) => `<li id="src-${i + 1}"><b>[${i + 1}]</b><a href="${esc(s.href)}">${esc(s.label)}</a></li>`).join("") || `<li class="muted">No sources.</li>`}</ol></div>
        <div class="panel"><h3>How this answer was found</h3><ol class="steps">${a.steps.map((s) => `<li><i></i><code>${esc(s.tool)}</code><span class="small">${esc(s.output)}</span><span class="tiny muted">${s.ms} ms</span></li>`).join("")}</ol>
          <p class="tiny muted" style="margin:8px 0 0">The same tools are exposed to IDEs and AI clients through the MCP server in the full design.</p></div>
      </div></div>`;
  $$("[data-src]").forEach((x) => (x.onclick = (e) => { e.preventDefault(); $$(".sources li").forEach((l) => l.classList.remove("hl")); const li = $(`#src-${x.dataset.src}`); li.classList.add("hl"); li.scrollIntoView({ block: "nearest", behavior: "smooth" }); }));
  $$("[data-fb]").forEach((b) => (b.onclick = async () => {
    await post("/api/feedback", { kind: b.dataset.fb, question: qtext, task: a.task, note: $("#fb-note").value });
    toast(b.dataset.fb === "up" ? "Thanks for the feedback." : "Thanks. Sent to the review queue for a domain expert.");
    $$("[data-fb]").forEach((x) => (x.disabled = true));
  }));
});

// ---------------- search ----------------
route("search", async (args, params) => {
  const qtext = params.get("q") || "";
  view.innerHTML = `<div><h1>Search</h1><p class="lede">Ticket numbers (<code>118256-02</code>) and CR families (<code>118256</code>) jump straight to the page. Code copies are collapsed into one result.</p></div>${askBox(qtext, "search")}<div id="res"></div>`;
  bindAskBox();
  if (!qtext) return;
  const r = await api(`/api/search?q=${encodeURIComponent(qtext)}`);
  if (r.jump) { location.hash = r.jump.replace("#/family/", "#/family/"); return; }
  const { cards, docs, code } = r.results;
  $("#res").innerHTML = `<div class="grid side">
    <div class="panel"><h3>Knowledge cards (${cards.length})</h3>${cards.map((c) => `<div class="hit"><a href="#/ticket/${c.task}"><b>${c.task}</b> ${esc(c.title)}</a><span class="tiny muted">${c.site} · ${esc(c.state)} ${tag(c.link_confidence)}</span><span class="small snippet">${c.snippet}</span></div>`).join("") || `<p class="muted">No cards match.</p>`}</div>
    <div class="grid"><div class="panel"><h3>Code (${code.length})</h3>${code.map((u) => `<div class="hit"><a class="mono" href="#/code?repo=${encodeURIComponent(u.repo)}&path=${encodeURIComponent(u.path)}">${esc(u.name)}</a><span class="tiny muted">${esc(u.repo)}/${esc(u.path)}${u.copies > 0 ? ` · +${u.copies} cop${u.copies > 1 ? "ies" : "y"}` : ""}</span></div>`).join("") || `<p class="muted">No code matches.</p>`}</div>
    <div class="panel"><h3>Documents (${docs.length})</h3>${docs.map((d) => `<div class="hit"><a href="#/ticket/${d.task}?tab=sources"><b>${d.task}</b> ${esc(d.file_name)}</a><span class="small snippet">${d.snippet}</span></div>`).join("") || `<p class="muted">No documents match.</p>`}</div></div></div>`;
});

// ---------------- functions ----------------
route("capabilities", async (args, params) => {
  const [caps, tags] = await Promise.all([api("/api/capabilities"), api("/api/tags")]);
  const sites = [...new Set(caps.flatMap((c) => c.site_list))].sort();
  const state = { text: params.get("q") || "", tag: params.get("tag") || "", site: "" };
  view.innerHTML = `<div><h1>Functions</h1><p class="lede">Every shopfloor function in the knowledge base, its tags and the sites where it was requested or found. Tags are assigned to each knowledge card when it is written.</p></div>
    <div class="panel fbar">
      <input id="fn-q" placeholder="Filter functions, e.g. feeder, label, packing, BKK…" value="${esc(state.text)}" aria-label="Filter functions">
      <select id="fn-site" aria-label="Site"><option value="">All sites</option>${sites.map((s) => `<option>${s}</option>`).join("")}</select>
      <div class="chips" id="fn-tags"><button class="chip ${state.tag ? "" : "on"}" data-tag="">All tags</button>${tags.filter((t) => t.functions).map((t) => `<button class="chip ${state.tag === t.tag ? "on" : ""}" data-tag="${esc(t.tag)}">${esc(t.tag)} <span class="muted tiny">${t.functions}</span></button>`).join("")}</div>
    </div>
    <p class="small muted" id="fn-count"></p><div class="caps" id="fn-list"></div>`;
  const draw = () => {
    const words = state.text.toLowerCase().split(/\s+/).filter(Boolean);
    const list = caps.filter((c) => {
      const hay = `${c.title} ${c.why} ${c.rule} ${c.tags.join(" ")} ${c.site_list.join(" ")} ${c.k}`.toLowerCase();
      return words.every((w) => hay.includes(w)) && (!state.tag || c.tags.includes(state.tag)) && (!state.site || c.site_list.includes(state.site));
    });
    $("#fn-count").textContent = `${list.length} of ${caps.length} functions`;
    $("#fn-list").innerHTML = list.map(capTile).join("") || `<div class="empty">No function matches. Try fewer words, or <a href="#/check?text=${encodeURIComponent(state.text)}">check the requirement</a> instead.</div>`;
  };
  $("#fn-q").oninput = (e) => { state.text = e.target.value; draw(); };
  $("#fn-site").onchange = (e) => { state.site = e.target.value; draw(); };
  $$("#fn-tags [data-tag]").forEach((b) => (b.onclick = () => { state.tag = b.dataset.tag; $$("#fn-tags .chip").forEach((x) => x.classList.toggle("on", x === b)); draw(); }));
  draw();
});
route("capability", async ([key]) => {
  const d = await api(`/api/capability/${key}`);
  const bySite = {};
  d.tickets.forEach((t) => (bySite[t.site] = bySite[t.site] || []).push(t));
  const copySites = {};
  d.copies.forEach((c) => c.sites.forEach((s) => (copySites[s] = copySites[s] || []).push(c)));
  const best = (l) => ["confirmed", "strong", "inferred", "unlinked"].find((x) => l.some((t) => t.link_confidence === x));
  const fams = [...new Set(d.tickets.map((t) => t.cr))];
  view.innerHTML = `
    <div><div class="small muted"><a href="#/capabilities">Functions</a> /</div><h1>${esc(d.title)}</h1>
      <p class="lede">${esc(d.rule)}. Built because ${esc(d.why)}.</p>
      ${d.tags && d.tags.length ? `<div class="sites" style="margin-top:8px">${d.tags.map((t) => `<a class="ftag" href="#/capabilities?tag=${encodeURIComponent(t.tag)}">${esc(t.tag)}</a>`).join("")}</div>` : ""}
      <div class="chips" style="margin-top:10px"><a class="btn sm" href="#/ask?q=${encodeURIComponent("Why was " + d.title.toLowerCase() + " built?")}">Ask why it was built</a><a class="btn sm" href="#/ask?q=${encodeURIComponent("Which sites have " + d.title.toLowerCase() + "?")}">Ask which sites have it</a></div></div>
    <div class="panel"><h2>Where it runs</h2><p class="small muted" style="margin-top:-4px">${Object.keys(bySite).length} site(s) with a change request${Object.keys(copySites).filter((s) => !bySite[s]).length ? `, plus ${Object.keys(copySites).filter((s) => !bySite[s]).length} with only a copy and no CR` : ""}${d.copies.length ? ` · ${d.copies.length} plug-and-play cop${d.copies.length > 1 ? "ies" : "y"} found in code` : ""} · ${fams.length} CR famil${fams.length > 1 ? "ies" : "y"}</p>
      <div class="sitegrid">${Object.entries(bySite).map(([s, list]) => `<div class="sitecol"><h3><span>${s}</span>${tag(best(list))}</h3><span class="tiny muted">${esc(list[0].customer)} · ${list[0].region}</span>
        ${list.map((t) => `<div class="rev"><a href="#/ticket/${t.task}"><b>${t.task}</b></a><span class="tiny">${esc(t.title.replace(/^[^:–]+[:–]\s*/, ""))}</span><span class="tiny muted">${esc(t.state)}</span></div>`).join("")}
        ${(copySites[s] || []).map((c) => `<div class="rev" style="border-top:1px dashed var(--warn);padding-top:6px"><span class="tag inferred">also a copy · no CR</span><a class="mono tiny" href="#/code?repo=${encodeURIComponent(c.repo)}">${esc(c.repo)}</a><span class="tiny">Copy of <a href="#/ticket/${c.task}">${c.task}</a>, ${c.source === "expert" ? "confirmed by an expert" : "found by code similarity"}</span></div>`).join("")}</div>`).join("")}
        ${Object.entries(copySites).filter(([s]) => !bySite[s]).map(([s, cs]) => `<div class="sitecol copy"><h3><span>${s}</span><span class="tag inferred">copy · no CR</span></h3>
        ${cs.map((c) => `<div class="rev"><a href="#/code?repo=${encodeURIComponent(c.repo)}"><b class="mono tiny">${esc(c.repo)}</b></a><span class="tiny">Plug-and-play copy of <a href="#/ticket/${c.task}">${c.task}</a>, ${c.source === "expert" ? "confirmed by an expert" : "found by code similarity"}</span></div>`).join("")}</div>`).join("")}</div></div>
    ${d.separate.length ? `<div class="panel"><h2>Built separately elsewhere</h2><p class="small muted">Similar requirement, different code. Candidates to merge or reuse next time.</p>${d.separate.map((s) => `<div class="hit"><a href="#/ticket/${s.task}"><b>${s.task}</b> ${esc(s.title)}</a><span class="tiny muted">${s.site} · similarity ${Number(s.score).toFixed(2)}</span></div>`).join("")}</div>` : ""}
    <div class="panel"><h2>Revisions and what they added</h2>${fams.map((cr) => `<h3 style="margin:12px 0 4px">CR ${cr} <a class="tiny" href="#/family/${cr}">family page</a></h3>${d.tickets.filter((t) => t.cr === cr).map((t) => `<div class="small"><a href="#/ticket/${t.task}">${t.task}</a> ${esc(t.title)} <span class="muted">· ${t.site} · ${fmtD(t.created)}</span></div>`).join("")}`).join("")}</div>
    <div class="panel"><h2>Code</h2>${d.units.length ? `<div class="grid">${groupBy(d.units, (u) => `${u.repo}/${u.path}`).map(([k, us]) => `<div class="small"><a class="mono" href="#/code?repo=${encodeURIComponent(us[0].repo)}&path=${encodeURIComponent(us[0].path)}">${esc(k)}</a><div class="tiny muted">${us.map((u) => `${esc(u.name)}${u.group_id ? ` (clone group ${u.group_id}${u.role === "origin" ? ", original" : ""})` : ""}`).join(" · ")}</div></div>`).join("")}</div>` : `<p class="muted">No linked code.</p>`}</div>`;
});
const groupBy = (arr, f) => { const m = new Map(); arr.forEach((x) => { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }); return [...m.entries()]; };

route("family", async ([cr]) => {
  const d = await api(`/api/family/${cr}`);
  view.innerHTML = `<div><h1>CR family ${esc(cr)}</h1><p class="lede">${d.tickets.length} revision(s). Each revision is newer functionality and may serve a different project.</p></div>
    ${d.tickets.map((t) => `<div class="panel"><h3><a href="#/ticket/${t.task}">${t.task}</a> ${esc(t.title)} ${tag(t.link_confidence)}</h3><p class="small muted">${esc(t.project)} · ${esc(t.state)} · created ${fmtD(t.created)}</p><div class="md small">${t.overview ? md(t.overview).replace(/\[((?:T|A|C)\d+)\]/g, '<span class="src">$1</span>') : "No card yet."}</div></div>`).join("")}`;
});

// ---------------- check before you build ----------------
const DRAFTS = [
  "Operators must get supervisor approval before reprinting a serial label, and reprints should be limited per unit.",
  "Track how long moisture sensitive reels are open on the floor and block them after the floor life expires.",
  "Weigh every carton at packing and reject it when the weight is outside tolerance.",
  "Show a dashboard of operator overtime per shift.",
];
route("check", async (args, params) => {
  view.innerHTML = `<div><h1>Check before you build</h1><p class="lede">Paste the requirement from a new change request. You will see whether the same or a similar function already exists, where it runs, and how well its code is linked. Use it at dev-lead approval, before anyone starts building.</p></div>
    <form class="askbox" id="chk"><textarea id="chk-t" placeholder="Describe the new requirement…">${esc(params.get("text") || "")}</textarea>
      <div class="askbox-row" style="align-items:center"><div class="chips" style="flex:1">${DRAFTS.map((d, i) => `<button type="button" class="chip" data-d="${i}">Example ${i + 1}</button>`).join("")}</div><button class="btn primary">Check</button></div></form>
    <div id="chk-r"></div>`;
  $$("[data-d]").forEach((b) => (b.onclick = () => { $("#chk-t").value = DRAFTS[b.dataset.d]; $("#chk").requestSubmit(); }));
  $("#chk").onsubmit = async (e) => {
    e.preventDefault();
    const text = $("#chk-t").value.trim();
    $("#chk-r").innerHTML = `<div class="panel thinking"><i></i>Comparing with every ticket and its documents…</div>`;
    try {
      const r = await post("/api/check", { text });
      const v = { exists: ["This function probably exists already", "Review the matches below before approving new development. Reusing it with a CR keeps the link visible."], partial: ["Something similar exists", "Parts of this requirement match existing functions. Check whether they can be extended."], new: ["No similar function found", "Nothing in the knowledge base matches closely. This looks like new work."] }[r.verdict];
      $("#chk-r").innerHTML = `<div class="verdict ${r.verdict}"><b>${v[0]}</b><span>${v[1]}</span>${r.short ? `<span class="small">Tip: describe the requirement in a full sentence (what must happen, where, with which limits) for a more reliable check.</span>` : ""}
        <span class="tiny">Compared on: ${r.keys.map((k) => k.known ? `<b>${esc(k.word)}</b>` : `<s title="not found anywhere in the knowledge base">${esc(k.word)}</s>`).join(", ") || "—"}${r.draft_tags.length ? ` · tags: ${r.draft_tags.map(esc).join(", ")}` : ""}</span></div>
        ${r.verdict === "new" && r.groups.length ? `<p class="small muted">Weak matches, shown for completeness:</p>` : ""}${r.groups.map((g) => `<div class="panel"><h3><a href="#/capability/${g.capability}">${esc(g.title)}</a> <span class="tiny muted">best match ${g.best.toFixed(2)}</span></h3>
          <div class="sites" style="margin:4px 0 8px">${g.sites.map((s) => `<span class="site">${s}</span>`).join("")}${g.tags.map((t) => `<span class="ftag" title="Tag shared with your requirement">${esc(t)}</span>`).join("")}</div>
          ${g.tickets.map((t) => `<div class="small"><a href="#/ticket/${t.task}">${t.task}</a> ${esc(t.title)} <span class="muted">· ${t.site} · ${esc(t.state)} · ${t.score.toFixed(2)}</span> ${tag(t.conf)}</div>`).join("")}</div>`).join("")}`;
    } catch (err) { $("#chk-r").innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
  };
  if (params.get("text")) $("#chk").requestSubmit();
});

// ---------------- ticket ----------------
route("ticket", async ([task], params) => {
  const d = await api(`/api/ticket/${task}`);
  const t = d.ticket, c = d.card;
  view.innerHTML = `
    <div><div class="small muted"><a href="#/capability/${t.capability}">${esc(t.title.split(/ [–:] |: /)[0])}</a> / <a href="#/family/${t.cr}">CR ${t.cr}</a> / revision ${String(t.rev).padStart(2, "0")}</div>
      <h1>${esc(t.task)} ${esc(t.title)}</h1>
      <div class="chips" style="margin-top:8px;align-items:center">${tag(c && c.link_confidence)} <span class="small muted">${esc(t.state)} · ${t.site} · ${esc(t.customer)}</span>
        <a class="btn sm primary" href="/api/package/${t.task}" download>Download ticket package</a></div></div>
    <div class="grid side">
      <div class="panel"><div class="tabs" id="tabs"><button data-t="card">Knowledge card</button><button data-t="sources">Sources (${d.documents.length + 1})</button><button data-t="code">Code (${d.links.length})</button><button data-t="history">History</button></div><div id="tab"></div></div>
      <div class="grid">
        ${d.tags && d.tags.length ? `<div class="panel"><h3>Tags</h3><div class="sites">${d.tags.map((t) => `<a class="ftag" href="#/capabilities?tag=${encodeURIComponent(t.tag)}" title="${esc(t.source)}: ${esc(t.evidence || "")}">${esc(t.tag)}</a>`).join("")}</div><p class="tiny muted" style="margin:6px 0 0">Assigned when the card was written. Hover a tag to see the words that triggered it.</p></div>` : ""}
        <div class="panel"><h3>At a glance</h3><dl class="kv"><dt>Project</dt><dd>${esc(t.project)}</dd><dt>Owner</dt><dd>${esc(t.owner)}</dd><dt>Created</dt><dd>${fmtD(t.created)}</dd><dt>Required</dt><dd>${fmtD(t.required)}</dd><dt>Card</dt><dd>${c ? `v${c.version} · ${esc(c.status)} · ${fmtD(c.generated_at)}` : "not yet"}</dd></dl></div>
        <div class="panel"><h3>Revisions</h3>${d.family.map((f) => `<div class="small">${f.task === t.task ? `<b>${f.task}</b>` : `<a href="#/ticket/${f.task}">${f.task}</a>`} ${esc(f.title.replace(/^[^:–]+[:–]\s*/, ""))}</div>`).join("")}</div>
        <div class="panel"><h3>Similar at other sites</h3>${d.similar.map((s) => `<div class="small"><a href="#/ticket/${s.task}">${s.task}</a> ${esc(s.title)} <span class="muted">${s.site}</span></div>`).join("") || `<span class="small muted">None found.</span>`}</div>
        <div class="panel"><h3>Something wrong?</h3><div class="fb"><input id="fb-note" placeholder="What is wrong? (optional)"><button class="btn sm" data-fb="wrong_link">Wrong link</button><button class="btn sm" data-fb="outdated">Outdated card</button><button class="btn sm" data-fb="up">👍 Useful</button></div><p class="tiny muted" style="margin:6px 0 0">Reports go to the review queue for a domain expert.</p></div>
      </div></div>`;
  const tabs = {
    card: () => (c ? card(c.card_md) : `<div class="empty">No knowledge card yet.</div>`),
    sources: () => `<h3>MyPM ticket text</h3><pre class="doc">${esc(t.body_md)}</pre>${d.documents.map((x) => `<h3>${esc(x.file_name)} <span class="tag">${x.format}</span></h3><pre class="doc">${esc(x.markdown)}</pre>`).join("")}`,
    code: () => d.links.length ? d.links.map((l) => `<div class="hit"><span>${tag(l.tier)}${l.source === "expert" ? ' <span class="tag strong">expert</span>' : ""} <a class="mono" href="#/code?repo=${encodeURIComponent(l.repo)}">${esc(l.repo)}</a> <span class="mono tiny">@${esc((l.commit_sha || "").slice(0, 7))}</span></span><span class="small">${esc(l.message || "")} <span class="muted">· ${esc(l.author || "")} · ${fmtD(l.committed_at)}</span></span><span class="tiny muted">${esc(l.evidence)}</span></div>`).join("") : `<div class="empty">No code linked to this ticket.</div>`,
    history: () => `<h3>Ticket edits</h3>${d.versions.map((v) => `<div class="small">Edit #${v.edit_no} · ${esc(v.state)} · required ${esc(v.required)}</div>`).join("")}<h3 style="margin-top:14px">Card versions</h3>${d.card_versions.map((v) => `<div class="small">v${v.version} · ${esc(v.model)} · ${fmtD(v.generated_at)}</div>`).join("")}`,
  };
  const show = (k) => { $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === k)); $("#tab").innerHTML = tabs[k](); };
  $$("#tabs button").forEach((b) => (b.onclick = () => show(b.dataset.t)));
  show(tabs[params.get("tab")] ? params.get("tab") : "card");
  $$("[data-fb]").forEach((b) => (b.onclick = async () => { await post("/api/feedback", { kind: b.dataset.fb, task: t.task, note: $("#fb-note").value }); toast(b.dataset.fb === "up" ? "Thanks!" : "Sent to the review queue."); b.disabled = true; }));
});
function card(text) {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  return `<div class="md">${md(body).replace(/\[((?:T|A|C)\d+)\]/g, '<span class="src">$1</span>')}</div>`;
}

// ---------------- code → requirement ----------------
let treeCache = null;
route("code", async (args, params) => {
  const repo = params.get("repo"), file = params.get("path"), line = Number(params.get("line") || 0);
  treeCache = treeCache || (await api("/api/tree"));
  view.innerHTML = `<div><h1>Code → requirement</h1><p class="lede">Pick a file and click any line. You get the commit that last changed it, the change request behind it, and why it was built, even when the original developer has left. This is what the IDE plug-in shows next to the code.</p></div>
    <div class="codeview"><div class="panel tree">${treeCache.map((r) => `<details ${r.repo === repo ? "open" : ""}><summary>${esc(r.repo)}</summary>${r.files.map((f) => `<a class="${r.repo === repo && f === file ? "on" : ""}" href="#/code?repo=${encodeURIComponent(r.repo)}&path=${encodeURIComponent(f)}">${esc(f)}</a>`).join("")}</details>`).join("") || `<span class="muted">No code yet.</span>`}</div>
      <div id="cv"><div class="empty">Choose a file on the left.</div></div><div id="why" class="panel"><h3>Why is this code here?</h3><p class="small muted">Click a line number.</p></div></div>`;
  if (!repo) return;
  const files = (treeCache.find((r) => r.repo === repo) || { files: [] }).files;
  const f = file || files[0];
  if (!f) return;
  const s = await api(`/api/source?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(f)}`);
  const unitAt = (n) => s.units.find((u) => n >= u.start_line && n <= u.end_line);
  $("#cv").innerHTML = `<div class="small muted" style="margin-bottom:6px"><b class="mono">${esc(repo)}/${esc(f)}</b> ${s.sites.length ? `· site ${s.sites.join(", ")}` : ""}</div>
    <div class="code"><table>${s.lines.map((l) => `<tr data-n="${l.n}" class="${unitAt(l.n) ? "unit" : ""}"><td class="n">${l.n}</td><td>${esc(l.text) || " "}</td></tr>`).join("")}</table></div>`;
  const pick = (n) => {
    $$(".code tr").forEach((tr) => tr.classList.toggle("sel", Number(tr.dataset.n) === n));
    const l = s.lines[n - 1]; if (!l) return;
    const cm = s.commits[l.sha] || {};
    const u = unitAt(n);
    const links = cm.links || [];
    $("#why").innerHTML = `<h3>Why is line ${n} here?</h3>
      <dl class="kv small"><dt>Commit</dt><dd class="mono">${l.sha.slice(0, 7)}</dd><dt>Author</dt><dd>${esc(cm.author || "")}</dd><dt>Date</dt><dd>${fmtD(cm.date)}</dd><dt>Message</dt><dd>“${esc(cm.message || "")}”</dd>${u ? `<dt>Function</dt><dd class="mono">${esc(u.name)}</dd>` : ""}</dl>
      <h3 style="margin-top:14px">Change request</h3>
      ${links.length ? links.map((k) => `<div class="hit"><span>${tag(k.tier)} <a href="#/ticket/${k.task}"><b>${k.task}</b></a></span><span class="small">${esc(k.title)}</span><span class="tiny muted">${esc(k.evidence)}</span></div>`).join("")
        : `<div class="empty small">No change request is linked to this commit. This is a knowledge gap; it is in the review queue.</div>`}
      ${u && u.others && u.others.length ? `<h3 style="margin-top:14px">Same code elsewhere</h3>${u.others.map((o) => `<div class="small"><a class="mono" href="#/code?repo=${encodeURIComponent(o.repo)}&path=${encodeURIComponent(o.path)}">${esc(o.repo)}</a> <span class="muted">${o.role}</span></div>`).join("")}` : ""}
      ${links[0] ? `<p class="small" style="margin-top:12px"><a href="#/ask?q=${encodeURIComponent("Why was " + links[0].title.replace(/ – .*$/, "").replace(/:.*$/, "").toLowerCase() + " built?")}">Ask why this was built →</a></p>` : ""}`;
  };
  $$(".code tr").forEach((tr) => (tr.onclick = () => pick(Number(tr.dataset.n))));
  const first = line || (s.units[0] && s.units[0].start_line) || 1;
  pick(first);
  const tr = $(`.code tr[data-n="${first}"]`); if (tr) tr.scrollIntoView({ block: "center" });
});

go();
