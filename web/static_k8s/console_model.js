// The cluster console's model. Pure: events in, state and animation cues
// out. No DOM and no timers, so Node can run it against a recorded event
// stream, and a page reload rebuilds the same picture from the history.
"use strict";

const ConsoleModel = {
  initial() {
    return {
      servers: {},        // name -> { kind, where, protocol, tools: [], resources: 0, prompts: 0 }
      owner: {},          // tool name -> server name
      menu: null,         // { offered: [...], blocked: [{ name, server, reason }] }
      turns: [],          // { text, note, rows: [...], t0, ms, done }
      stats: { turns: 0, calls: 0, denied: 0, errors: 0 },
    };
  },

  // now: ms timestamp when the event arrived live, or null when it came
  // from the history (no timings, no animation for those).
  // Returns { state, cues }: cues tell the map what to animate.
  apply(state, ev, now) {
    const s = state;
    const cues = [];
    const turn = s.turns[s.turns.length - 1];
    switch (ev.type) {
      case "ConfigLoaded": {
        // A new host process: startup begins again.
        const fresh = ConsoleModel.initial();
        for (const srv of ev.servers || []) fresh.servers[srv.name] = { kind: srv.kind, where: srv.where, protocol: "", tools: [], resources: 0, prompts: 0 };
        return { state: fresh, cues: [{ cue: "startup" }] };
      }
      case "ServerConnected":
        ensureServer(s, ev.server, ev.kind, ev.where);
        cues.push({ cue: "call", server: ev.server, label: "connect" });
        break;
      case "Handshake":
        ensureServer(s, ev.server).protocol = ev.protocol_version;
        cues.push({ cue: "return", server: ev.server, error: false });
        break;
      case "ToolsDiscovered": {
        const srv = ensureServer(s, ev.server);
        srv.tools = (ev.tool_names || []).slice();
        srv.resources = (ev.resource_uris || []).length;
        srv.prompts = (ev.prompt_names || []).length;
        for (const t of srv.tools) s.owner[t] = ev.server;
        break;
      }
      case "MenuBuilt":
        s.menu = { offered: (ev.offered || []).slice(), blocked: (ev.blocked || []).map((b) => ({ ...b })) };
        break;
      case "TurnStarted":
        s.turns.push({ text: ev.text, note: ev.note || "", rows: [], t0: now, ms: null, done: false });
        s.stats.turns += 1;
        cues.push({ cue: "ask" });
        break;
      case "ModelCalled":
        if (!turn) break;
        turn.rows.push({ kind: "claude", call: ev.call_number, max: ev.max_calls, seconds: ev.elapsed_seconds,
          tokensIn: ev.input_tokens, tokensOut: ev.output_tokens, stop: ev.stop_reason });
        cues.push({ cue: "claude", label: `${ev.elapsed_seconds} s` });
        break;
      case "ToolRequested":
        if (!turn) break;
        turn.rows.push({ kind: "tool", id: ev.tool_use_id, name: ev.name, args: ev.args || {}, server: s.owner[ev.name] || "",
          verdict: "asked", reason: "", result: null, t0: null, ms: null });
        s.stats.calls += 1;
        break;
      case "PolicyDecided": {
        const row = pendingTool(turn, ev.name);
        if (!row) break;
        row.reason = ev.reason;
        if (ev.allowed) {
          row.verdict = "allowed";
          row.t0 = now;
          cues.push({ cue: "call", server: row.server, label: row.name });
        } else {
          // The host's own policy stopped it: the call never left the host pod.
          row.verdict = "denied-host";
          s.stats.denied += 1;
          cues.push({ cue: "deny", at: "host", server: row.server, label: row.name });
        }
        break;
      }
      case "ToolReturned": {
        const row = pendingTool(turn, ev.name, true);
        if (!row) break;
        row.result = { isError: ev.is_error, text: ev.text };
        if (now !== null && row.t0 !== null) row.ms = Math.round(now - row.t0);
        if (ev.is_error && /Gateway: /.test(ev.text)) {
          // The host allowed it; the gateway's copy of the policy did not.
          row.verdict = "denied-gateway";
          s.stats.denied += 1;
          cues.push({ cue: "deny", at: "gateway", server: row.server, label: row.name });
        } else {
          if (ev.is_error) s.stats.errors += 1;
          cues.push({ cue: "return", server: row.server, error: ev.is_error });
        }
        break;
      }
      case "SimulatedReply":
        if (!turn) break;
        turn.rows.push({ kind: "note", tone: "amber", text: ev.tool ? `SIMULATED: Claude's reply replaced with ${ev.tool}` : "Simulation armed, nothing replaced" });
        break;
      case "FinalAnswer":
        if (!turn) break;
        turn.rows.push({ kind: "answer", reason: ev.reason, chars: (ev.text || "").length });
        finish(turn, now);
        cues.push({ cue: "answer" });
        break;
      case "TurnFailed":
        if (!turn) break;
        turn.rows.push({ kind: "failed", error: ev.error });
        s.stats.errors += 1;
        finish(turn, now);
        break;
      case "Reset":
        s.turns = [];
        s.stats = { turns: 0, calls: 0, denied: 0, errors: 0 };
        break;
      default:
        return { state: s, cues };
    }
    return { state: s, cues };
  },
};

function ensureServer(s, name, kind, where) {
  if (!s.servers[name]) s.servers[name] = { kind: kind || "", where: where || "", protocol: "", tools: [], resources: 0, prompts: 0 };
  if (kind) s.servers[name].kind = kind;
  if (where) s.servers[name].where = where;
  return s.servers[name];
}

// The oldest tool row with this name still waiting for its next event.
function pendingTool(turn, name, forResult) {
  if (!turn) return null;
  return turn.rows.find((r) => r.kind === "tool" && r.name === name &&
    (forResult ? r.verdict === "allowed" && r.result === null : r.verdict === "asked")) || null;
}

function finish(turn, now) {
  turn.done = true;
  if (now !== null && turn.t0 !== null) turn.ms = Math.round(now - turn.t0);
}

if (typeof module !== "undefined") module.exports = ConsoleModel;
