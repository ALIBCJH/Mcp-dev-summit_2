// Demo 2 (k3d): relabel the flow table for the cluster. Loaded after
// flow_data.js and before the code that draws it. Ids, positions and edges
// stay as they are, so the reducer and the strip need no change.
"use strict";

(function () {
  const SUBS = {
    policy: "ConfigMap",
    flights: "HTTP, in a pod",
    hotels: "HTTP, in a pod",
    bookings: "HTTP, 2 pods",
  };
  for (const node of FLOW.nodes) if (SUBS[node.id]) node.sub = SUBS[node.id];
  // Every call to a server now crosses the gateway, which is where the
  // MCP band already sits in the picture.
  FLOW.band.label = "GATEWAY · MCP (JSON-RPC)";
  for (const box of FLOW.containers) if (box.id === "host") box.label = "Host pod";
})();
