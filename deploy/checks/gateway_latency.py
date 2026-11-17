"""How much time does the gateway add to one tool call?

Runs inside the cluster (the Service names only resolve there):

    kubectl -n safiri exec -i deploy/host -- python - < deploy/checks/gateway_latency.py

Makes 50 get_flight_status calls straight to the flights server and 50
through the gateway, on one connection each, and prints a small table.
"""

import asyncio
import statistics
import time

from mcp import Client
from mcp.client.streamable_http import streamable_http_client

CALLS = 50
ROUTES = {
    "direct": "http://flights:9000/mcp",
    "via gateway": "http://gateway:8080/flights/mcp",
}


async def measure(url: str) -> list[float]:
    """Milliseconds for each of CALLS tool calls."""
    times = []
    async with Client(streamable_http_client(url)) as client:
        await client.call_tool("get_flight_status", {"flight": "KF101"})  # warm-up, not counted
        for _ in range(CALLS):
            start = time.perf_counter()
            result = await client.call_tool("get_flight_status", {"flight": "KF101"})
            times.append((time.perf_counter() - start) * 1000)
            assert not result.is_error
    return times


async def main() -> None:
    results = {name: await measure(url) for name, url in ROUTES.items()}
    print(f"{CALLS} get_flight_status calls each, milliseconds per call")
    print(f"{'route':<12} {'median':>8} {'mean':>8} {'p95':>8} {'max':>8}")
    for name, times in results.items():
        p95 = sorted(times)[int(CALLS * 0.95) - 1]
        print(f"{name:<12} {statistics.median(times):>8.1f} {statistics.mean(times):>8.1f} {p95:>8.1f} {max(times):>8.1f}")
    added = statistics.median(results["via gateway"]) - statistics.median(results["direct"])
    print(f"gateway adds about {added:.1f} ms per call (difference of medians)")


asyncio.run(main())
