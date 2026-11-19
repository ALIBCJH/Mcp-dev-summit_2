// The cluster map: one SVG of the namespace. Boxes are Deployments (and the
// ConfigMap and Secret), chips inside them are pods. It draws pods from
// /api/cluster and animates the cues ConsoleModel returns. It decides nothing.
"use strict";

const SVG_NS = "http://www.w3.org/2000/svg";

const MAP = {
  viewBox: [0, 0, 1000, 420],
  ns: { x: 200, y: 8, w: 792, h: 404, label: "namespace safiri" },
  // kind: "outside" (not in the cluster), "deploy" (has pods), "config"
  boxes: {
    claude:   { x: 16,  y: 40,  w: 160, h: 64,  kind: "outside", title: "Claude API",   sub: "api.anthropic.com", family: "api" },
    you:      { x: 16,  y: 300, w: 160, h: 64,  kind: "outside", title: "Your browser", sub: "127.0.0.1:8080 → NodePort", family: "you" },
    secret:   { x: 224, y: 32,  w: 172, h: 60,  kind: "config",  title: "Secret safiri-api", sub: "API key · never shown", family: "secret" },
    host:     { x: 224, y: 140, w: 172, h: 112, kind: "deploy",  title: "host",    sub: "agent loop · policy", family: "k8s", replicas: 1 },
    policy:   { x: 224, y: 324, w: 172, h: 60,  kind: "config",  title: "ConfigMap policy", sub: "5 tools", family: "k8s" },
    gateway:  { x: 452, y: 140, w: 172, h: 112, kind: "deploy",  title: "gateway", sub: "checks tools/call", family: "k8s", replicas: 1 },
    redis:    { x: 452, y: 316, w: 172, h: 84,  kind: "deploy",  title: "redis",   sub: "bookings store", family: "mcp", replicas: 1 },
    flights:  { x: 692, y: 22,  w: 290, h: 104, kind: "deploy",  title: "flights",  sub: "", family: "mcp", replicas: 1 },
    hotels:   { x: 692, y: 146, w: 290, h: 104, kind: "deploy",  title: "hotels",   sub: "", family: "mcp", replicas: 1 },
    bookings: { x: 692, y: 270, w: 290, h: 130, kind: "deploy",  title: "bookings", sub: "", family: "mcp", replicas: 2 },
  },
  // style: "wire" (traffic flows) or "mount" (config mounted, dashed)
  edges: [
    { id: "you-host",         from: "you",     to: "host",     style: "wire", family: "you" },
    { id: "host-claude",      from: "host",    to: "claude",   style: "wire", family: "api" },
    { id: "host-gateway",     from: "host",    to: "gateway",  style: "wire", family: "mcp", label: "MCP" },
    { id: "gateway-flights",  from: "gateway", to: "flights",  style: "wire", family: "mcp" },
    { id: "gateway-hotels",   from: "gateway", to: "hotels",   style: "wire", family: "mcp" },
    { id: "gateway-bookings", from: "gateway", to: "bookings", style: "wire", family: "mcp" },
    { id: "bookings-redis",   from: "bookings", to: "redis",   style: "wire", family: "mcp" },
    { id: "secret-host",      from: "secret",  to: "host",     style: "mount", family: "secret" },
    { id: "policy-host",      from: "policy",  to: "host",     style: "mount", family: "k8s" },
    { id: "policy-gateway",   from: "policy",  to: "gateway",  style: "mount", family: "k8s" },
  ],
};

const PULSE_MS = 380;

const ClusterMap = {
  svg: null,
  parts: {},          // box id -> { g, sub, pods }
  edgeEls: {},        // edge id -> { g, p1, p2 }
  queue: Promise.resolve(),
  pending: 0,

  build(holder) {
    const [x0, y0, w, h] = MAP.viewBox;
    const svg = svgEl("svg", { viewBox: `${x0} ${y0} ${w} ${h}`, class: "map-svg", role: "img", "aria-label": "Safiri in the cluster: pods and the calls between them" });
    const ns = MAP.ns;
    const nsG = svgEl("g", { class: "nsg" });
    nsG.appendChild(svgEl("rect", { x: ns.x, y: ns.y, width: ns.w, height: ns.h, rx: 14, class: "ns" }));
    nsG.appendChild(svgText(ns.x + 14, ns.y + ns.h - 10, ns.label, "ns-label", "start"));
    svg.appendChild(nsG);
    this.nsG = nsG;

    for (const e of MAP.edges) {
      const [p1, p2] = anchors(MAP.boxes[e.from], MAP.boxes[e.to]);
      const g = svgEl("g", { class: `edge ${e.style} ${e.family}` });
      g.appendChild(svgEl("line", { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }));
      if (e.label) g.appendChild(svgText((p1.x + p2.x) / 2, (p1.y + p2.y) / 2 - 8, e.label, "edge-label"));
      svg.appendChild(g);
      this.edgeEls[e.id] = { g, p1, p2, from: e.from, to: e.to };
    }

    for (const [id, b] of Object.entries(MAP.boxes)) {
      const g = svgEl("g", { class: `box ${b.kind} ${b.family}`, "data-id": id });
      g.appendChild(svgEl("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 10, class: "frame" }));
      g.appendChild(svgText(b.x + 12, b.y + 22, b.title, "title", "start"));
      if (b.kind === "deploy") g.appendChild(svgText(b.x + b.w - 10, b.y + 20, "Deployment", "kind", "end"));
      const sub = svgText(b.x + 12, b.y + 40, b.sub, "sub", "start");
      g.appendChild(sub);
      const pods = svgEl("g", { class: "pods" });
      g.appendChild(pods);
      svg.appendChild(g);
      this.parts[id] = { g, sub, pods };
      if (b.kind === "deploy") this.drawPods(id, null);
    }
    this.badges = svgEl("g", { class: "badges" });
    svg.appendChild(this.badges);
    this.dots = svgEl("g", { class: "dots" });
    svg.appendChild(this.dots);
    holder.appendChild(svg);
    this.svg = svg;
  },

  setSub(id, text) { if (this.parts[id]) this.parts[id].sub.textContent = text; },

  // The architecture tour builds the picture piece by piece. shown: a Set
  // of box ids (plus "ns" for the namespace), or null for everything. An
  // edge appears once both of its ends are on the map and draws itself in;
  // fresh: ids that scale in and glow.
  setVisible(shown, fresh) {
    const on = (id) => shown === null || shown.has(id);
    for (const [id, part] of Object.entries(this.parts)) part.g.classList.toggle("off", !on(id));
    for (const e of Object.values(this.edgeEls)) {
      const wasOn = !e.g.classList.contains("off"), nowOn = on(e.from) && on(e.to);
      e.g.classList.toggle("off", !nowOn);
      if (nowOn && !wasOn && fresh && fresh.length) drawIn(e.g.querySelector("line"), 700, 250);
    }
    this.nsG.classList.toggle("off", !on("ns"));
    for (const id of fresh || []) {
      if (id === "ns") { drawIn(this.nsG.querySelector("rect"), 1100, 0); restartClass(this.nsG, "flash-ns"); }
      else restartClass(this.parts[id].g, "enter");
    }
  },

  // pods: [{ name, app, phase, ready, terminating, restarts }] or null when
  // the pod watch is off; then each box shows its configured replicas.
  setPods(pods) {
    for (const [id, b] of Object.entries(MAP.boxes)) {
      if (b.kind !== "deploy") continue;
      this.drawPods(id, pods ? pods.filter((p) => p.app === id) : null);
    }
  },

  drawPods(id, list) {
    const b = MAP.boxes[id], holder = this.parts[id].pods;
    holder.textContent = "";
    const chips = list === null
      ? Array.from({ length: b.replicas }, () => ({ label: "pod", cls: "static", title: "pod (live pod view is off)" }))
      : list.map((p) => ({ label: podLabel(p), cls: podClass(p), title: `${p.name} · ${podState(p)}${p.restarts ? ` · ${p.restarts} restart(s)` : ""}` }));
    if (list !== null && chips.length === 0) chips.push({ label: "no pods", cls: "failed", title: "no pod for this Deployment" });
    const gap = 6, n = chips.length, cw = Math.min(88, (b.w - 20 - gap * (n - 1)) / n), ch = 26;
    chips.forEach((c, i) => {
      const x = b.x + 10 + i * (cw + gap), y = b.y + b.h - ch - 10;
      const g = svgEl("g", { class: `pod ${c.cls}` });
      const t = svgEl("title", {}); t.textContent = c.title; g.appendChild(t);
      g.appendChild(svgEl("rect", { x, y, width: cw, height: ch, rx: 6 }));
      g.appendChild(svgText(x + cw / 2, y + 17, c.label, "pod-label"));
      holder.appendChild(g);
    });
  },

  // ---- animation ---------------------------------------------------------
  // Cues run one after another so a burst reads in order. A long backlog
  // (a slow tab catching up) is dropped rather than replayed late.
  play(cue) {
    if (this.pending > 6) return;
    this.pending += 1;
    this.queue = this.queue.then(() => this.run(cue)).catch(() => {}).then(() => { this.pending -= 1; });
  },

  async run(c) {
    switch (c.cue) {
      case "ask":    await this.pulse("you-host", false, "you"); this.flash("host", "ok"); break;
      case "answer": await this.pulse("you-host", true, "you"); this.flash("you", "ok"); break;
      case "claude":
        await this.pulse("host-claude", false, "api");
        this.flash("claude", "api");
        this.badge("claude", c.label, "api");
        await this.pulse("host-claude", true, "api");
        break;
      case "call":
        if (!c.server) break;
        await this.pulse("host-gateway", false, "mcp");
        this.flash("gateway", "ok");
        await this.pulse(`gateway-${c.server}`, false, "mcp");
        this.flash(c.server, "ok");
        if (c.label && c.label !== "connect") this.badge(c.server, c.label, "mcp");
        if (c.server === "bookings" && c.label && c.label !== "connect") await this.pulse("bookings-redis", false, "mcp");
        break;
      case "return":
        if (!c.server) break;
        await this.pulse(`gateway-${c.server}`, true, c.error ? "err" : "mcp");
        await this.pulse("host-gateway", true, c.error ? "err" : "mcp");
        break;
      case "deny":
        if (c.at === "gateway") {
          await this.pulse("host-gateway", false, "mcp");
          this.flash("gateway", "err");
          this.badge("gateway", `DENIED ${c.label}`, "err");
          await this.pulse("host-gateway", true, "err");
        } else {
          this.flash("host", "err");
          this.badge("host", `DENIED ${c.label}`, "err");
          await wait(600);
        }
        break;
      default:
        break;
    }
  },

  pulse(edgeId, reverse, tone) {
    const e = this.edgeEls[edgeId];
    if (!e) return Promise.resolve();
    const a = reverse ? e.p2 : e.p1, b = reverse ? e.p1 : e.p2;
    restartClass(e.g, `hot-${tone}`);
    const dot = svgEl("circle", { r: 7, class: `dot ${tone}`, cx: a.x, cy: a.y });
    this.dots.appendChild(dot);
    return new Promise((resolve) => {
      const t0 = performance.now();
      const step = (t) => {
        const k = Math.min(1, (t - t0) / PULSE_MS), q = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        dot.setAttribute("cx", a.x + (b.x - a.x) * q);
        dot.setAttribute("cy", a.y + (b.y - a.y) * q);
        if (k < 1) requestAnimationFrame(step); else { dot.remove(); resolve(); }
      };
      requestAnimationFrame(step);
    });
  },

  flash(id, tone) { if (this.parts[id]) restartClass(this.parts[id].g, `flash-${tone}`); },

  badge(id, text, tone) {
    const b = MAP.boxes[id];
    if (!b) return;
    const g = svgEl("g", { class: `badge ${tone}` });
    const w = Math.max(70, text.length * 8.4 + 20), x = b.x + b.w / 2 - w / 2, y = b.y - 15;
    g.appendChild(svgEl("rect", { x, y, width: w, height: 24, rx: 12 }));
    g.appendChild(svgText(b.x + b.w / 2, y + 17, text, "badge-text"));
    this.badges.appendChild(g);
    setTimeout(() => g.remove(), 2600);
  },
};

// ---- helpers ----------------------------------------------------------------
function svgEl(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  return n;
}
function svgText(x, y, text, cls, anchor) {
  const t = svgEl("text", { x, y, class: cls, "text-anchor": anchor || "middle" });
  t.textContent = text;
  return t;
}
// Points on the two box edges that face each other, so lines meet the boxes.
function anchors(a, b) {
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  return [edgePoint(a, ca, cb), edgePoint(b, cb, ca)];
}
function edgePoint(box, c, toward) {
  const dx = toward.x - c.x, dy = toward.y - c.y;
  const sx = dx === 0 ? Infinity : (box.w / 2) / Math.abs(dx), sy = dy === 0 ? Infinity : (box.h / 2) / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}
function restartClass(node, cls) {
  node.classList.remove(cls);
  void node.getBoundingClientRect();   // reflow, so the animation runs again
  node.classList.add(cls);
  setTimeout(() => node.classList.remove(cls), 1400);
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
// Draw a line or rect as if a pen traced it: dash it to its own length and
// slide the dash in. Inline styles only while it runs, so the normal dash
// pattern of mounts and the namespace comes back afterwards.
function drawIn(shape, ms, delay) {
  if (!shape || !shape.getTotalLength || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const len = shape.getTotalLength();
  const st = shape.style;
  st.transition = "none"; st.strokeDasharray = `${len}`; st.strokeDashoffset = `${len}`;
  void shape.getBoundingClientRect();
  st.transition = `stroke-dashoffset ${ms}ms ease-out ${delay}ms`;
  st.strokeDashoffset = "0";
  setTimeout(() => { st.transition = ""; st.strokeDasharray = ""; st.strokeDashoffset = ""; }, ms + delay + 50);
}
function podState(p) {
  if (p.terminating) return "Terminating";
  if (p.phase === "Running" && p.ready) return "Running, ready";
  if (p.phase === "Running") return "Running, not ready";
  return p.phase;
}
function podClass(p) {
  if (p.terminating) return "terminating";
  if (p.phase === "Running" && p.ready) return "ok";
  if (p.phase === "Failed" || p.phase === "Unknown") return "failed";
  return "starting";
}
// The last five characters are the part of a pod name that changes.
function podLabel(p) {
  const tail = p.name.slice(-5);
  if (p.terminating) return `✕ ${tail}`;
  if (p.phase === "Running" && p.ready) return `● ${tail}`;
  return `◌ ${tail}`;
}
