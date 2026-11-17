"""Demo 2 (k3d) only: the cluster look for the same page.

Switched on by UI_SKIN=k8s in the host pod. Unset, this module is never
imported and the page is Demo 1's, byte for byte.

It adds three things and changes nothing in web/static:
    GET /                the same index.html with three extra tags
    GET /k8s/...         the extra CSS and scripts (web/static_k8s)
    GET /api/cluster     what the cluster card shows: policy and bookings

The card is display only. Every decision is still made by host/policy.py
and the gateway; the bookings rows are read from Redis, never written.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from host import policy

STATIC_DIR = Path(__file__).parent / "static"
SKIN_DIR = Path(__file__).parent / "static_k8s"
# A new pod means new files: the stamp stops the browser reusing old ones.
STAMP = str(int(time.time()))


def page() -> str:
    """index.html plus the skin's tags. Each anchor must be found exactly
    once, so a later change to index.html fails loudly here, not silently."""
    html = (STATIC_DIR / "index.html").read_text()
    edits = [
        ('data-theme="light"', 'data-theme="light" data-skin="k8s"'),
        ('<link rel="stylesheet" href="/static/style.css">',
         '<link rel="stylesheet" href="/static/style.css">\n'
         f'<link rel="stylesheet" href="/k8s/cluster.css?v={STAMP}">'),
        # After the flow table, before the code that draws it.
        ('<script src="/static/flow_data.js"></script>',
         '<script src="/static/flow_data.js"></script>\n'
         f'<script src="/k8s/cluster_flow.js?v={STAMP}"></script>'),
        ('<script src="/static/app.js"></script>',
         '<script src="/static/app.js"></script>\n'
         f'<script src="/k8s/cluster_card.js?v={STAMP}"></script>'),
    ]
    for old, new in edits:
        if html.count(old) != 1:
            raise RuntimeError(f"skin_k8s: expected exactly one {old!r} in index.html")
        html = html.replace(old, new)
    return html


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


def install(app: FastAPI, demo: Any) -> None:
    app.mount("/k8s", StaticFiles(directory=str(SKIN_DIR)), name="k8s")
    html = page()

    @app.get("/")
    async def index() -> HTMLResponse:
        return HTMLResponse(html)

    @app.get("/api/cluster")
    async def cluster() -> dict[str, Any]:
        view: dict[str, Any] = {
            "pod": os.environ.get("HOSTNAME", ""),
            "policy": _policy_rows(demo),
            "store": None,
        }
        url = os.environ.get("REDIS_URL")
        if url:
            try:
                view["store"] = await asyncio.to_thread(_read_redis, url)
            except Exception as exc:  # the card says so; the demo carries on
                view["store_error"] = type(exc).__name__
        return view
