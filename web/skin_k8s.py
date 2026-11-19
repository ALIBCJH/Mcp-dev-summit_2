"""Demo 2 (k3d) only: the cluster look for the same page.

Switched on by UI_SKIN=k8s in the host pod. Unset, this module is never
imported and the page is Demo 1's, byte for byte.

It adds these routes and changes nothing in web/static:
    GET /                the cluster console (web/static_k8s/console.html)
    GET /k8s/...         the console's CSS and scripts
    GET /api/cluster     policy, bookings and (POD_WATCH=on) the pods

All of it is display only. Every decision is still made by host/policy.py
and the gateway; bookings are read from Redis, never written; pods are
listed, never changed.
"""

from __future__ import annotations

import asyncio
import json
import os
import ssl
import time
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from host import policy

SKIN_DIR = Path(__file__).parent / "static_k8s"
# A new pod means new files: the stamp stops the browser reusing old ones.
STAMP = str(int(time.time()))


def _policy_rows(demo: Any) -> list[dict[str, str]]:
    """Every tool the servers offered at startup, and what the policy file
    says about it right now."""
    listed = policy.allowed()
    tools = demo.host.tools if demo.host is not None else []
    return [
        {"name": t["name"], "server": t["server"],
         "kind": listed.get(t["name"], ""), "state": "allowed" if t["name"] in listed else "denied"}
        for t in tools
    ]


def _read_redis(url: str) -> dict[str, Any]:
    import redis  # only in the cluster image

    client = redis.Redis.from_url(url, decode_responses=True, socket_timeout=1, socket_connect_timeout=1)
    try:
        bookings = []
        for key in sorted(client.scan_iter("booking:*")):
            raw = client.get(key)
            if raw:
                bookings.append(json.loads(raw))
        repeats = []
        for key in sorted(client.scan_iter("repeat:*")):
            repeats.append({"key": key, "booking_id": client.get(key) or "", "seconds_left": client.ttl(key)})
        return {"bookings": bookings, "repeats": repeats}
    finally:
        client.close()


# POD_WATCH=on: list the pods in this namespace with the pod's own service
# account (read-only Role in deploy/k8s/host.yaml). Only the fields below
# leave this function; never the pod spec, never the token.
SA_DIR = Path("/var/run/secrets/kubernetes.io/serviceaccount")


def _read_pods() -> list[dict[str, Any]]:
    token = (SA_DIR / "token").read_text().strip()
    namespace = (SA_DIR / "namespace").read_text().strip()
    context = ssl.create_default_context(cafile=str(SA_DIR / "ca.crt"))
    api = f"https://{os.environ['KUBERNETES_SERVICE_HOST']}:{os.environ['KUBERNETES_SERVICE_PORT']}"
    request = urllib.request.Request(f"{api}/api/v1/namespaces/{namespace}/pods",
                                     headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, context=context, timeout=2) as reply:
        items = json.load(reply).get("items", [])
    pods = []
    for item in items:
        meta, status = item.get("metadata", {}), item.get("status", {})
        containers = status.get("containerStatuses") or []
        pods.append({
            "name": meta.get("name", ""),
            "app": (meta.get("labels") or {}).get("app", ""),
            "phase": status.get("phase", "Unknown"),
            "ready": bool(containers) and all(c.get("ready") for c in containers),
            "terminating": bool(meta.get("deletionTimestamp")),
            "restarts": sum(c.get("restartCount", 0) for c in containers),
        })
    return sorted(pods, key=lambda p: (p["app"], p["name"]))


def install(app: FastAPI, demo: Any) -> None:
    app.mount("/k8s", StaticFiles(directory=str(SKIN_DIR)), name="k8s")
    console = (SKIN_DIR / "console.html").read_text().replace("__STAMP__", STAMP)

    @app.get("/")
    async def index() -> HTMLResponse:
        return HTMLResponse(console, headers={"Cache-Control": "no-store"})

    @app.get("/api/cluster")
    async def cluster() -> dict[str, Any]:
        view: dict[str, Any] = {
            "pod": os.environ.get("HOSTNAME", ""),
            "policy": _policy_rows(demo),
            "store": None,
            "pods": None,
        }
        url = os.environ.get("REDIS_URL")
        if url:
            try:
                view["store"] = await asyncio.to_thread(_read_redis, url)
            except Exception as exc:  # the card says so; the demo carries on
                view["store_error"] = type(exc).__name__
        if os.environ.get("POD_WATCH") == "on":
            try:
                view["pods"] = await asyncio.to_thread(_read_pods)
            except Exception as exc:  # the map falls back to static tiles
                view["pods_error"] = type(exc).__name__
        return view
