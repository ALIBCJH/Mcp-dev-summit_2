// The architecture tour: the opening of the cluster console. It builds the
// map from the ground up (namespace first, visitor last), one piece at a
// time, in plain words, for an audience that has never heard of Kubernetes. The presenter drives it: → or Space next, ← back,
// Esc skips. The "Tour" button plays it again.
"use strict";

// Each step adds boxes (ids from MAP.boxes, "ns" for the namespace).
// term: the one technical word this step introduces, explained.
const TOUR_STEPS = [
  { add: ["ns"], headline: "This is the architecture",
    body: "One small Kubernetes cluster runs on this laptop (k3s, inside Docker). Inside it, one fenced-off area holds everything Safiri needs. Let's build it up, piece by piece.",
    term: ["Namespace", "a fenced-off area of the cluster for one app. Ours is called safiri."] },
  { add: ["secret"], headline: "A locked drawer for the key",
    body: "Safiri needs a key to talk to Claude. The cluster keeps it in a locked drawer and hands it to one box only. It never appears on this page.",
    term: ["Secret", "a locked settings file, for passwords and keys."] },
  { add: ["policy"], headline: "The rules are a list, not code",
    body: "Which tools may be used is a short list the cluster hands to the boxes. Change the list and they follow it within seconds. No restart, no new version.",
    term: ["ConfigMap", "a settings file the cluster hands to the boxes."] },
  { add: ["redis"], headline: "One shared notebook",
    body: "Bookings are written into a small, fast shared store, so every copy of the booking tool sees the same trips and the same trip is never booked twice.",
    term: ["Pod", "a sealed box that runs one program. Redis is the first one on our map; every running box here is one."] },
  { add: ["flights", "hotels"], headline: "Tools that know things",
    body: "Flights knows routes, prices and delays. Hotels knows places to stay. Each is its own box and a network service that speaks MCP over Streamable HTTP. Demo 1 ran its tools as local processes over stdio; here they are services anyone in the building can call.",
    term: ["MCP", "the common language an AI app uses to talk to its tools. Streamable HTTP is how it travels over the network."] },
  { add: ["bookings"], headline: "A tool that does things, twice",
    body: "Bookings can actually book a trip, so it gets the most care. It runs as two identical copies: if one dies, the other carries on, and both write to the same notebook.",
    term: ["Replicas", "identical copies of the same box."] },
  { add: ["gateway"], headline: "A checkpoint in front of the tools",
    body: "Every tool request passes through the gateway, which checks it against the rules before letting it through. Inside the building, boxes find each other by name: gateway, redis, flights.",
    term: ["Service", "a stable name and address for a box, however many times it is replaced."] },
  { add: ["host"], headline: "Safiri's brain",
    body: "One program receives your message, keeps the conversation going, asks Claude what to do next and calls the tools through the gateway. It is the only box handed the key and the rules." },
  { add: ["you"], headline: "The one door in",
    body: "Nothing inside is reachable from outside, except one door: the cluster opens port 30080 and forwards it to Safiri's brain. On this laptop that door is 127.0.0.1:8080, the page you are looking at.",
    term: ["NodePort", "a port Kubernetes opens on the outside and forwards to one Service."] },
  { add: ["claude"], headline: "The AI lives outside the building",
    body: "Safiri sends the conversation to Claude, at Anthropic. Claude writes the answers, or asks Safiri to use a tool. Claude can only ask; it cannot reach any box by itself." },
  { add: [], headline: "Now watch a request travel",
    body: "Ask Safiri for a trip. Every step lights up on this map, and the list underneath shows exactly what happened, as it happens." },
];

const Tour = {
  index: -1,
  active: false,

  start() {
    this.active = true;
    document.body.classList.add("touring");
    this.box = document.getElementById("tour");
    this.box.hidden = false;
    this.index = -1;
    this.go(0);
    if (!this.bound) {
      document.addEventListener("keydown", (e) => this.key(e), true);
      document.getElementById("tour-next").addEventListener("click", () => this.go(this.index + 1));
      document.getElementById("tour-back").addEventListener("click", () => this.go(this.index - 1));
      document.getElementById("tour-skip").addEventListener("click", () => this.end());
      this.bound = true;
    }
  },

  key(e) {
    if (!this.active || e.ctrlKey || e.metaKey || e.altKey) return;
    const next = e.key === "ArrowRight" || e.key === " " || e.key === "Enter" || e.key === "PageDown";
    const back = e.key === "ArrowLeft" || e.key === "PageUp";
    if (next) this.go(this.index + 1);
    else if (back) this.go(this.index - 1);
    else if (e.key === "Escape") this.end();
    else { e.stopPropagation(); return; }   // T, K and the rest wait until the tour is over
    e.preventDefault();
    e.stopPropagation();
  },

  go(i) {
    if (i >= TOUR_STEPS.length) { this.end(); return; }
    if (i < 0) return;
    const forward = i > this.index;
    this.index = i;
    const shown = new Set();
    TOUR_STEPS.slice(0, i + 1).forEach((s) => s.add.forEach((id) => shown.add(id)));
    const step = TOUR_STEPS[i];
    ClusterMap.setVisible(i === TOUR_STEPS.length - 1 ? null : shown, forward ? step.add : []);

    document.getElementById("tour-count").textContent = `${i + 1} / ${TOUR_STEPS.length}`;
    document.getElementById("tour-headline").textContent = step.headline;
    document.getElementById("tour-body").textContent = step.body;
    const term = document.getElementById("tour-term");
    term.hidden = !step.term;
    if (step.term) {
      term.querySelector(".word").textContent = step.term[0];
      term.querySelector(".means").textContent = step.term[1];
    }
    document.getElementById("tour-back").disabled = i === 0;
    document.getElementById("tour-next").textContent = i === TOUR_STEPS.length - 1 ? "Start the demo" : "Next →";
    const caption = document.querySelector(".tour-caption");
    caption.classList.remove("enter"); void caption.offsetWidth; caption.classList.add("enter");
  },

  end() {
    this.active = false;
    ClusterMap.setVisible(null, []);
    this.box.hidden = true;
    document.body.classList.remove("touring");
    document.getElementById("chat-input").focus();
  },
};
