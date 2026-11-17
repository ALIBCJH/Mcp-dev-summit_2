"""MCP gateway: one door in front of the three MCP servers.

    /flights/mcp  ->  http://flights:9000/mcp      (same for hotels, bookings)

Every request is passed on untouched, headers included, except one kind:
a tools/call for a tool that is not on the allow-list is answered here with
a tool error, and the server never sees it.

The allow-list is the same file the host reads (one ConfigMap, mounted in
both pods) and the check is the same function, host/policy.py.
"The code decides how to check. The config decides what's allowed."

Environment
    GATEWAY_SERVERS    names that may be reached, e.g. "flights,hotels,bookings"
    UPSTREAM_TEMPLATE  where a name lives, e.g. "http://{server}:9000/mcp"
    GATEWAY_PORT       default 8080
    POLICY_SOURCE, POLICY_FILE   read by host/policy.py
"""

from __future__ import annotations

import json
import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import httpx2
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from host import policy  # noqa: E402

logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="[gateway] %(levelname)s %(message)s")
log = logging.getLogger("gateway")
# One line per forwarded request from the HTTP library would bury the
# allowed/DENIED lines this file prints.
logging.getLogger("httpx2").setLevel(logging.WARNING)

SERVERS = [s.strip() for s in os.environ.get("GATEWAY_SERVERS", "flights,hotels,bookings").split(",")]
UPSTREAM_TEMPLATE = os.environ.get("UPSTREAM_TEMPLATE", "http://{server}:9000/mcp")

# Headers that describe one network hop, not the message. Everything else,
# including every Mcp-* header, is forwarded exactly as it arrived.
HOP_HEADERS = {"host", "content-length", "connection", "keep-alive", "transfer-encoding", "upgrade"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # No keep-alive to the servers: every request opens a new connection, so
    # Kubernetes picks a live pod each time. A kept connection to a pod that
    # was just deleted would fail the next call.
    app.state.client = httpx2.AsyncClient(
        limits=httpx2.Limits(max_keepalive_connections=0),
        timeout=httpx2.Timeout(30, connect=3),
    )
    log.info("servers: %s, allow-list: %s", ", ".join(SERVERS), ", ".join(sorted(policy.allowed())))
    yield
    await app.state.client.aclose()


app = FastAPI(title="Safiri MCP gateway", lifespan=lifespan)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.api_route("/{server}/mcp", methods=["GET", "POST", "DELETE"])
async def mcp(server: str, request: Request) -> Response:
    if server not in SERVERS:
        return JSONResponse({"error": f"unknown server {server!r}"}, status_code=404)

    # ---- checkpoint 3: token at the door -------------------------------
    # Phase 5 checks the caller's token and scopes here, before anything
    # else. Not built for Demo 2.
    # ---------------------------------------------------------------------

    body = await request.body()
    denied = _denied_tool_call(server, body)
    if denied is not None:
        return denied
    return await _forward(server, request, body)


def _denied_tool_call(server: str, body: bytes) -> Response | None:
    """A ready-made answer when the body is a tools/call for a tool that is
    not allowed; None for everything else."""
    try:
        message = json.loads(body) if body else None
    except ValueError:
        return None  # not ours to judge; the server will reject it
    if isinstance(message, list):
        # A batch could hide a tools/call. This SDK never sends one.
        return JSONResponse({"error": "JSON-RPC batches are not accepted"}, status_code=400)
    if not isinstance(message, dict) or message.get("method") != "tools/call":
        return None

    tool = str((message.get("params") or {}).get("name", ""))
    decision = policy.check(tool, {})
    if decision.allowed:
        log.info("allowed %s on %s", tool, server)
        return None
    log.warning("DENIED  %s on %s: not on the allow-list", tool, server)
    # A normal tools/call result with isError, not a JSON-RPC error: the
    # model reads the reason as a tool error and the turn carries on.
    # resultType "complete" is what this SDK's servers send with every result.
    result = {
        "content": [{"type": "text", "text": f"Gateway: {decision.reason}"}],
        "isError": True,
        "resultType": "complete",
    }
    return JSONResponse({"jsonrpc": "2.0", "id": message.get("id"), "result": result})


async def _forward(server: str, request: Request, body: bytes) -> Response:
    client: httpx2.AsyncClient = request.app.state.client
    headers = [(k, v) for k, v in request.headers.items() if k.lower() not in HOP_HEADERS]
    upstream = client.build_request(
        request.method, UPSTREAM_TEMPLATE.format(server=server), headers=headers, content=body
    )
    try:
        reply = await _send(client, upstream)
    except httpx2.HTTPError as exc:
        log.error("%s unreachable: %s", server, type(exc).__name__)
        return JSONResponse({"error": f"server {server!r} is not reachable"}, status_code=502)
    # Streamed back as it arrives: an MCP answer may be one JSON document or
    # a stream of events, and the gateway does not need to know which.
    reply_headers = {k: v for k, v in reply.headers.items() if k.lower() not in HOP_HEADERS}
    return StreamingResponse(
        reply.aiter_raw(), status_code=reply.status_code, headers=reply_headers,
        background=BackgroundTask(reply.aclose),
    )


async def _send(client: httpx2.AsyncClient, upstream: httpx2.Request) -> httpx2.Response:
    try:
        return await client.send(upstream, stream=True)
    except httpx2.ConnectError:
        # The connection was never made, so the server saw nothing and one
        # more try is safe. This covers the moment a pod has just been deleted.
        return await client.send(upstream, stream=True)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("BIND_HOST", "127.0.0.1"),
                port=int(os.environ.get("GATEWAY_PORT", "8080")), log_level="warning")
