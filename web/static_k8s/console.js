// The cluster console: wires the page to the host. Events in (SSE), chat
// and reset out (POST), cluster card polled from /api/cluster. The model
// (console_model.js) decides what an event means; the map
// (console_map.js) draws it; this file owns the DOM around them.
"use strict";

const EVENT_TYPES = ["ConfigLoaded", "ServerConnected", "Handshake", "ToolsDiscovered", "MenuBuilt",
  "TurnStarted", "ModelCalled", "ToolRequested", "PolicyDecided", "WireMessage", "ToolReturned",
  "FinalAnswer", "TurnFailed", "SimulatedReply", "Reset"];
const POLL_MS = 1500;
const FRESH_MS = 20000;      // a policy change stays highlighted this long
const CLIP = 1200;           // characters of a tool result shown in the trace

const App = {
  state: ConsoleModel.initial(),
  seen: new Set(),
  lastSeq: 0,
  historyUpTo: 0,            // events up to this seq are history: no timings, no animation
  busy: false,
  cluster: null,             // last /api/cluster reply
  policySeen: {},            // tool -> state at the previous poll
  policyChangedAt: {},
  openRows: new Set(),       // trace rows the presenter opened, kept across repaints
  startupOpen: true,

  async start() {
    ClusterMap.build(document.getElementById("map"));
    this.bindControls();
    this.applyTheme(readStore("k8s-theme") || "dark");
    try {
      const st = await (await fetch("/api/state", { cache: "no-store" })).json();
      this.historyUpTo = st.last_seq;
      document.getElementById("model").textContent = st.model || "";
    } catch (e) { /* the stream will still connect */ }
    this.connect();
    this.poll();
    setInterval(() => this.poll(), POLL_MS);
    Tour.start();   // the opening: how Safiri is built, piece by piece
  },

  // ---- events --------------------------------------------------------------
  connect() {
    const src = new EventSource("/api/events?after=0");
    for (const t of EVENT_TYPES) src.addEventListener(t, (e) => this.receive(JSON.parse(e.data)));
    src.onopen = () => this.conn(true);
    src.onerror = () => { this.conn(false); this.checkRestart(); };
    this.source = src;
  },

  // A new host pod numbers its events from 1 again: start over cleanly.
  async checkRestart() {
    try {
      const st = await (await fetch("/api/state", { cache: "no-store" })).json();
      if (st.last_seq < this.lastSeq) location.reload();
    } catch (e) { /* host still down; EventSource keeps retrying */ }
  },

  receive(ev) {
    if (this.seen.has(ev.seq)) return;
    this.seen.add(ev.seq);
    if (ev.seq > this.lastSeq) this.lastSeq = ev.seq;
    const live = ev.seq > this.historyUpTo;
    const r = ConsoleModel.apply(this.state, ev, live ? performance.now() : null);
    this.state = r.state;
    if (live) for (const c of r.cues) ClusterMap.play(c);
    this.chatEvent(ev);
    this.paintServers();
    this.paintTrace();
  },

  conn(up) {
    const n = document.getElementById("conn");
    n.className = up ? "conn up" : "conn down";
    n.title = up ? "Live event stream: connected" : "Live event stream: reconnecting…";
  },

  // ---- chat ----------------------------------------------------------------
  async send(text) {
    text = String(text || "").trim();
    if (!text || this.busy) return;
    this.busy = true;
    document.body.classList.add("busy");
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 || res.status === 400) this.chatLine("note", body.error || `HTTP ${res.status}`);
      else if (res.ok && body.note && body.answer === null) this.chatLine("note", body.note);
      // 502: the TurnFailed event already put the error in the chat.
    } catch (e) {
      this.chatLine("error", `Could not reach Safiri: ${e.message}`);
    } finally {
      this.busy = false;
      document.body.classList.remove("busy");
      document.getElementById("chat-input").focus();
    }
  },

  // The chat is rebuilt from events, so a reload shows the same conversation.
  chatEvent(ev) {
    const log = document.getElementById("chat-log");
    if (ev.type === "Reset" || ev.type === "ConfigLoaded") { log.textContent = ""; return; }
    if (ev.type === "TurnStarted") {
      this.chatLine("you", ev.text, ev.note);
      this.thinking(true);
    } else if (ev.type === "FinalAnswer") {
      this.thinking(false);
      const turn = this.state.turns[this.state.turns.length - 1];
      this.chatLine("safiri", ev.text, null, turn ? scoreLine(turn) : "");
    } else if (ev.type === "TurnFailed") {
      this.thinking(false);
      this.chatLine("error", `The turn failed: ${ev.error}`);
    }
  },

  chatLine(kind, text, note, score) {
    const log = document.getElementById("chat-log");
    const box = el("div", `msg ${kind}`);
    if (kind === "you" || kind === "safiri") box.appendChild(el("div", "who", kind === "you" ? "You" : "Safiri"));
    const body = el("div", "text");
    if (kind === "safiri") body.innerHTML = renderMarkdown(text);   // escapes everything first
    else body.textContent = text;
    box.appendChild(body);
    if (note) box.appendChild(el("div", "msg-note", note));
    if (score) box.appendChild(el("div", "score", score));
    log.appendChild(box);
    log.scrollTop = log.scrollHeight;
  },

  thinking(on) {
    const old = document.getElementById("thinking");
    if (old) old.remove();
    if (!on) return;
    const t = el("div", "msg thinking");
    t.id = "thinking";
    t.appendChild(el("span", "", "Safiri is working"));
    t.appendChild(el("span", "dots", "…"));
    const log = document.getElementById("chat-log");
    log.appendChild(t);
    log.scrollTop = log.scrollHeight;
  },

  // ---- trace ---------------------------------------------------------------
  paintTrace() {
    const trace = document.getElementById("trace");
    const atBottom = trace.scrollHeight - trace.scrollTop - trace.clientHeight < 40;
    for (const d of trace.querySelectorAll("details[data-key]")) {
      if (d.open) this.openRows.add(d.dataset.key); else this.openRows.delete(d.dataset.key);
    }
    const startup = trace.querySelector("details.startup");
    if (startup) this.startupOpen = startup.open;
    trace.textContent = "";
    trace.appendChild(this.startupGroup());
    this.state.turns.forEach((t, i) => trace.appendChild(this.turnGroup(t, i)));
    if (atBottom) trace.scrollTop = trace.scrollHeight;
  },

  startupGroup() {
    const s = this.state, names = Object.keys(s.servers);
    const g = el("details", "group startup");
    g.open = this.startupOpen;
    const http = names.filter((n) => s.servers[n].kind === "http").length;
    const head = s.menu
      ? `${names.length} MCP servers · ${http} over Streamable HTTP · ${s.menu.offered.length} tools offered, ${s.menu.blocked.length} blocked`
      : "waiting for the host to start…";
    g.appendChild(summary("STARTUP", head, "k8s"));
    for (const n of names) {
      const v = s.servers[n];
      const line = el("div", "line mcp");
      line.appendChild(el("span", "who", n));
      line.appendChild(el("span", "pill", v.kind || "?"));
      line.appendChild(el("code", "", v.where));
      line.appendChild(el("span", "muted", `${v.protocol ? `protocol ${v.protocol} · ` : ""}${v.tools.length} tool${v.tools.length === 1 ? "" : "s"}${v.resources ? ` · ${v.resources} resource${v.resources === 1 ? "" : "s"}` : ""}${v.prompts ? ` · ${v.prompts} prompt${v.prompts === 1 ? "" : "s"}` : ""}`));
      g.appendChild(line);
    }
    if (s.menu) {
      const line = el("div", "line k8s");
      line.appendChild(el("span", "who", "policy"));
      line.appendChild(el("span", "", `offers Claude ${s.menu.offered.join(", ") || "nothing"}`));
      if (s.menu.blocked.length) line.appendChild(el("span", "bad", ` · blocked ${s.menu.blocked.map((b) => b.name).join(", ")}`));
      g.appendChild(line);
    }
    return g;
  },

  turnGroup(t, i) {
    const g = el("section", "group turn");
    const head = el("div", "turn-head");
    head.appendChild(el("span", "tag you", `TURN ${i + 1}`));
    head.appendChild(el("span", "q", `"${short(t.text, 90)}"`));
    head.appendChild(el("span", "muted", t.done ? (t.ms !== null ? `${(t.ms / 1000).toFixed(1)} s` : "done") : "running…"));
    g.appendChild(head);
    t.rows.forEach((r, j) => g.appendChild(this.traceRow(r, `${i}:${j}`)));
    return g;
  },

  traceRow(r, key) {
    if (r.kind === "claude") {
      return plainRow("api", "Claude", `call ${r.call} of ${r.max} · ${r.seconds} s · ${fmt(r.tokensIn)} in / ${fmt(r.tokensOut)} out · ${r.stop === "tool_use" ? "asks for a tool" : r.stop}`);
    }
    if (r.kind === "answer") return plainRow("you", "Answer", `${r.reason} · ${fmt(r.chars)} characters, shown in the chat`);
    if (r.kind === "failed") return plainRow("err", "Failed", r.error);
    if (r.kind === "note") return plainRow("amber", "Note", r.text);

    // A tool call: where it went and what came back.
    const call = `${r.name}(${argsShort(r.args)})`;
    let tone, label, head;
    if (r.verdict === "asked") { tone = "muted"; label = "…"; head = `${call} · waiting for the policy`; }
    else if (r.verdict === "denied-host") { tone = "err"; label = "DENIED at host"; head = `${call} · ${r.reason}`; }
    else if (r.verdict === "denied-gateway") { tone = "err"; label = "DENIED at gateway"; head = `${call} · ${stripGateway(r.result.text)}`; }
    else if (!r.result) { tone = "mcp"; label = "→"; head = `${call} · host → gateway → ${r.server} pod · running…`; }
    else if (r.result.isError) { tone = "amber"; label = "error"; head = `${call} · ${r.server} answered with an error`; }
    // ms: measured by this page, from the policy's yes to the result arriving.
    else { tone = "mcp"; label = "✓"; head = `${call} · host → gateway → ${r.server} pod${r.ms !== null ? ` · ≈${r.ms} ms` : ""}`; }

    const d = el("details", `row ${tone}`);
    d.dataset.key = key;
    d.open = this.openRows.has(key);
    const s = el("summary");
    s.appendChild(el("span", "label", label));
    s.appendChild(el("span", "head", head));
    d.appendChild(s);
    const body = el("div", "body");
    body.appendChild(el("div", "sub", "arguments"));
    body.appendChild(el("pre", "", JSON.stringify(r.args, null, 2)));
    body.appendChild(el("div", "sub", "policy"));
    body.appendChild(el("pre", "", r.reason || "(no decision yet)"));
    if (r.result) {
      body.appendChild(el("div", "sub", r.result.isError ? "error returned" : "result returned to Claude"));
      body.appendChild(el("pre", "", clip(r.result.text)));
    }
    d.appendChild(body);
    return d;
  },

  // The map's server boxes list the tools each server offered at startup.
  paintServers() {
    for (const [name, v] of Object.entries(this.state.servers)) {
      ClusterMap.setSub(name, `${v.kind === "http" ? "HTTP :9000 · " : ""}${v.tools.join(" · ")}`);
    }
  },

  // ---- the cluster card ----------------------------------------------------
  async poll() {
    let view;
    try {
      const res = await fetch("/api/cluster", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      view = await res.json();
    } catch (e) {
      document.querySelector(".cards").classList.add("stale");
      return;
    }
    document.querySelector(".cards").classList.remove("stale");
    this.cluster = view;
    ClusterMap.setPods(view.pods || null);
    this.paintPodsReady(view.pods);
    this.paintPolicy(view.policy || []);
    this.paintBookings(view);
  },

  paintPodsReady(pods) {
    const n = document.getElementById("pods-ready");
    if (!pods) { n.textContent = "live pod view off"; n.className = "pods-ready off"; return; }
    const live = pods.filter((p) => !p.terminating);
    const ready = live.filter((p) => p.phase === "Running" && p.ready).length;
    const going = pods.length - live.length;
    n.textContent = `${ready}/${live.length} pods ready${going ? ` · ${going} terminating` : ""}`;
    n.className = `pods-ready ${ready === live.length && !going ? "ok" : "warn"}`;
  },

  paintPolicy(rows) {
    const now = Date.now(), chips = document.getElementById("policy-chips");
    chips.textContent = "";
    let note = "";
    for (const r of rows) {
      const before = this.policySeen[r.name];
      if (before && before !== r.state) this.policyChangedAt[r.name] = now;
      this.policySeen[r.name] = r.state;
      const age = now - (this.policyChangedAt[r.name] || 0), fresh = age < FRESH_MS;
      const c = el("span", `chip ${r.state}${r.kind === "side_effect" ? " side" : ""}${fresh ? " fresh" : ""}`, r.name);
      c.title = r.state === "allowed" ? `${r.server} · ${r.kind}` : `${r.server} · not in the policy file`;
      chips.appendChild(c);
      if (fresh) note = `${r.name} ${r.state === "allowed" ? "is back in" : "was removed from"} the policy ${Math.round(age / 1000)} s ago · no restart, no rebuild`;
    }
    document.getElementById("policy-note").textContent = note;
    const allowedCount = rows.filter((r) => r.state === "allowed").length;
    ClusterMap.setSub("policy", `${allowedCount} of ${rows.length} tools allowed`);
  },

  paintBookings(view) {
    const holder = document.getElementById("bookings");
    holder.textContent = "";
    if (!view.store) { holder.appendChild(el("span", "muted", view.store_error ? `Redis not reachable (${view.store_error})` : "no store")); return; }
    const locks = {};
    for (const r of view.store.repeats) locks[r.booking_id] = r.seconds_left;
    if (!view.store.bookings.length) { holder.appendChild(el("span", "muted", "no bookings yet")); return; }
    for (const b of view.store.bookings) {
      const row = el("div", "booking");
      row.appendChild(el("b", "", b.booking_id));
      row.appendChild(el("span", "", ` ${b.flight} · ${b.hotel} · ${b.nights} night${b.nights === 1 ? "" : "s"} · KES ${fmt(b.total_kes)}`));
      const left = locks[b.booking_id];
      if (left > 0) {
        const lock = el("span", "lock", `repeat-safe ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`);
        lock.title = "The same flight, hotel and nights returns this booking, not a second one";
        row.appendChild(lock);
      }
      holder.appendChild(row);
    }
  },

  // ---- controls ------------------------------------------------------------
  bindControls() {
    document.getElementById("chat-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = document.getElementById("chat-input");
      const text = input.value;
      input.value = "";
      this.send(text);
    });
    for (const b of document.querySelectorAll(".quick button")) b.addEventListener("click", () => this.send(b.dataset.send));
    document.getElementById("reset-btn").addEventListener("click", async () => {
      const res = await fetch("/api/reset", { method: "POST" });
      if (res.status === 409) this.chatLine("note", "A turn is running. Reset when it has finished.");
    });
    document.getElementById("theme-btn").addEventListener("click", () => this.toggleTheme());
    document.getElementById("closing-btn").addEventListener("click", () => Closing.show());
    document.getElementById("tour-btn").addEventListener("click", () => Tour.start());
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.matches("input, textarea, select")) return;
      if (e.key === "k" || e.key === "K") Closing.show();
      if (e.key === "t" || e.key === "T") this.toggleTheme();
      if (e.key === "a" || e.key === "A") Tour.start();
    });
  },

  applyTheme(name) {
    document.documentElement.dataset.theme = name;
    document.getElementById("theme-btn").textContent = name === "dark" ? "Light" : "Dark";
    writeStore("k8s-theme", name);
  },
  toggleTheme() { this.applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); },
};

// ---- closing card -------------------------------------------------------------
const Closing = {
  show() {
    const card = document.getElementById("closing");
    if (!card.hidden) return;
    const s = App.state.stats, c = App.cluster;
    const bookings = c && c.store ? c.store.bookings.length : 0;
    const pods = c && c.pods ? c.pods.filter((p) => !p.terminating).length : null;
    document.getElementById("closing-stats").textContent =
      `${s.turns} turn${s.turns === 1 ? "" : "s"} · ${s.calls} tool call${s.calls === 1 ? "" : "s"} · ${s.denied} denied by policy · ${bookings} booking${bookings === 1 ? "" : "s"} in Redis${pods !== null ? ` · ${pods} pods` : ""}`;
    card.hidden = false;
    const close = () => { card.hidden = true; document.removeEventListener("keydown", close, true); card.removeEventListener("click", close); };
    setTimeout(() => { document.addEventListener("keydown", close, true); card.addEventListener("click", close); }, 400);
  },
};

// ---- helpers ----------------------------------------------------------------------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}
function summary(tag, text, tone) {
  const s = el("summary");
  s.appendChild(el("span", `tag ${tone}`, tag));
  s.appendChild(el("span", "head", text));
  return s;
}
function plainRow(tone, label, text) {
  const d = el("div", `row plain ${tone}`);
  d.appendChild(el("span", "label", label));
  d.appendChild(el("span", "head", text));
  return d;
}
function scoreLine(turn) {
  const claude = turn.rows.filter((r) => r.kind === "claude"), tools = turn.rows.filter((r) => r.kind === "tool");
  const denied = tools.filter((r) => r.verdict.startsWith("denied")).length;
  const secs = turn.ms !== null ? (turn.ms / 1000).toFixed(1) : claude.reduce((a, r) => a + r.seconds, 0).toFixed(1);
  const tin = claude.reduce((a, r) => a + r.tokensIn, 0), tout = claude.reduce((a, r) => a + r.tokensOut, 0);
  return `${tools.length} tool call${tools.length === 1 ? "" : "s"}${denied ? ` (${denied} denied)` : ""} · ${claude.length} Claude call${claude.length === 1 ? "" : "s"} · ${secs} s · ${fmt(tin)} in / ${fmt(tout)} out tokens`;
}
function argsShort(args) {
  return Object.entries(args || {}).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ");
}
function stripGateway(text) { const i = text.indexOf("Gateway: "); return i >= 0 ? text.slice(i + 9) : text; }
function short(text, max) { text = String(text || "").replace(/\s+/g, " ").trim(); return text.length > max ? text.slice(0, max - 1) + "…" : text; }
function clip(text) { text = String(text || ""); return text.length > CLIP ? `${text.slice(0, CLIP)}\n… (${fmt(text.length - CLIP)} more characters)` : text; }
function fmt(n) { return Number(n || 0).toLocaleString("en-US"); }
function readStore(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function writeStore(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } }

App.start();
