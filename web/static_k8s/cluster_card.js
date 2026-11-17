// Demo 2 (k3d): the cluster card. One bar under the kernel toolbar that
// shows the policy ConfigMap and the bookings in Redis, live.
// It only reads GET /api/cluster; it decides nothing.
"use strict";

const ClusterCard = {
  POLL_MS: 1500,
  FRESH_MS: 20000,          // how long a changed tool stays marked "changed N s ago"
  last: {},                 // tool name -> state at the previous poll
  changedAt: {},            // tool name -> ms timestamp of its last change
  el: null,

  start() {
    this.addBadge();
    this.el = document.createElement("div");
    this.el.id = "cluster-card";
    this.el.className = "cluster-card";
    this.el.innerHTML =
      '<div class="cc-half cc-policy"><span class="cc-title">POLICY <small>ConfigMap · read live</small></span>' +
      '<span class="cc-chips"></span><span class="cc-note"></span></div>' +
      '<div class="cc-half cc-store"><span class="cc-title">BOOKINGS <small>Redis · shared by 2 pods</small></span>' +
      '<span class="cc-rows"></span></div>';
    const toolbar = document.querySelector(".bonnet .panel-toolbar");
    toolbar.insertAdjacentElement("afterend", this.el);
    this.poll();
    setInterval(() => this.poll(), this.POLL_MS);
  },

  addBadge() {
    const badge = document.createElement("span");
    badge.id = "cluster-badge";
    badge.className = "badge cluster-badge";
    badge.textContent = "Demo 2 · Kubernetes";
    document.querySelector(".topbar h1").insertAdjacentElement("afterend", badge);
    document.querySelector(".topbar .tagline").textContent = "Kenya travel assistant, in a cluster";
  },

  async poll() {
    let view;
    try {
      const reply = await fetch("/api/cluster", { cache: "no-store" });
      if (!reply.ok) throw new Error(String(reply.status));
      view = await reply.json();
    } catch (e) {
      this.el.classList.add("stale");   // host pod restarting: keep the last picture, dimmed
      return;
    }
    this.el.classList.remove("stale");
    if (view.pod) document.getElementById("cluster-badge").title = `host pod ${view.pod}`;
    this.paintPolicy(view.policy || []);
    this.paintStore(view);
  },

  paintPolicy(rows) {
    const now = Date.now();
    const chips = this.el.querySelector(".cc-chips");
    chips.textContent = "";
    let note = "";
    for (const row of rows) {
      const before = this.last[row.name];
      if (before && before !== row.state) this.changedAt[row.name] = now;
      this.last[row.name] = row.state;
      const age = now - (this.changedAt[row.name] || 0);
      const fresh = age < this.FRESH_MS;
      const chip = document.createElement("span");
      chip.className = `cc-chip ${row.state}${row.kind === "side_effect" ? " side" : ""}${fresh ? " fresh" : ""}`;
      chip.title = row.state === "allowed" ? `${row.server} · ${row.kind}` : `${row.server} · not in the policy file`;
      chip.textContent = row.name;
      chips.appendChild(chip);
      if (fresh) {
        const what = row.state === "allowed" ? "back in the policy" : "removed from the policy";
        note = `${row.name} ${what} ${Math.round(age / 1000)} s ago · no restart, no rebuild`;
      }
    }
    this.el.querySelector(".cc-note").textContent = note;
  },

  paintStore(view) {
    const holder = this.el.querySelector(".cc-rows");
    holder.textContent = "";
    const add = (cls, text) => {
      const span = document.createElement("span");
      span.className = cls; span.textContent = text;
      holder.appendChild(span);
    };
    if (!view.store) { add("cc-empty", view.store_error ? `Redis not reachable (${view.store_error})` : "no store"); return; }
    const locks = {};
    for (const r of view.store.repeats) locks[r.booking_id] = r.seconds_left;
    if (!view.store.bookings.length) { add("cc-empty", "no bookings yet"); return; }
    for (const b of view.store.bookings) {
      const row = document.createElement("span");
      row.className = "cc-booking";
      const id = document.createElement("b"); id.textContent = b.booking_id;
      row.appendChild(id);
      row.appendChild(document.createTextNode(
        ` ${b.flight} · ${b.hotel} · ${b.nights} night${b.nights === 1 ? "" : "s"} · KES ${Number(b.total_kes).toLocaleString("en-US")}`));
      const left = locks[b.booking_id];
      if (left > 0) {
        // While this lock lives, the same request returns this booking.
        const lock = document.createElement("span");
        lock.className = "cc-lock";
        lock.title = "The same flight, hotel and nights returns this booking, not a second one";
        lock.textContent = `repeat-safe ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
        row.appendChild(lock);
      }
      holder.appendChild(row);
    }
  },
};

// The presenter notes (N) were written for Demo 1. In the cluster all three
// servers are HTTP; this file loads after notes.js, so it can fix the line.
if (typeof Notes !== "undefined" && Notes.NOTES.boot) {
  Notes.NOTES.boot.lines[0] =
    "The host is our program. It reads servers.json: three servers, all over HTTP, each in its own pod, all behind the gateway.";
}

ClusterCard.start();
