# Safiri Demo 2: the same app on Kubernetes

Demo 1 runs Safiri as two processes on the laptop. Demo 2 runs the same
code in a small k3d cluster, with a gateway in front of the MCP servers,
bookings in Redis, and the allow-list in a ConfigMap. Demo 1 still works
exactly as before: every change is switched on by an environment variable
that only the cluster sets.

    Chrome -> 127.0.0.1:8080 -> host -> gateway -> flights / hotels / bookings
                                                                  bookings -> Redis

For the talk itself, read `STAGE.md`.

## Run it

```bash
deploy/k3d_install.sh    # once: k3d v5.9.0 into ~/.local/bin, sha256 checked
deploy/up.sh             # cluster, image, secret, pods. Safe to run again.
deploy/preflight.sh      # green READY or a red line with its fix
deploy/down.sh           # stop; images stay cached. --delete removes it all
```

`up.sh` needs `.env` in the project root (the same file Demo 1 uses).
Put the key in `.env`, never in `.env.example`: that file is in git.

Every script uses `deploy/kubeconfig.yaml` and nothing else, so your other
kube contexts are never read or changed. To use kubectl by hand:

```bash
export KUBECONFIG=deploy/kubeconfig.yaml
kubectl -n safiri get pods
```

## What is where

| File | Job |
|---|---|
| `Dockerfile`, `Dockerfile.dockerignore` | one image for the host, the gateway and the three servers |
| `requirements-k8s.txt` | the one extra package, `redis` |
| `build_image.sh` | fetch wheels, build, copy the images into the node |
| `gateway/gateway.py` | the gateway |
| `k8s/*.yaml` | one file per piece; `policy-configmap.yaml` is the allow-list |
| `checks/gateway_latency.py` | time added by the gateway |
| `checks/reload_timing.sh` | time for a ConfigMap edit to reach the pods |
| `wheels/`, `kubeconfig.yaml` | generated, not in git |

Pods and memory limits: redis 64Mi; flights, hotels, gateway and two
bookings 128Mi each; host 256Mi. The cluster node used about 775 MiB.

## The switches

All unset in Demo 1.

| Variable | Set on | Effect |
|---|---|---|
| `MCP_TRANSPORT=http` | flights, hotels | serve over Streamable HTTP instead of stdio |
| `BIND_HOST=0.0.0.0` | servers, gateway | listen for other pods, not only localhost |
| `WEB_BIND=0.0.0.0` | host | the same, for the web app |
| `SERVERS_FILE` | host | where the list of server addresses is |
| `POLICY_SOURCE=file`, `POLICY_FILE` | host, gateway | read the allow-list from a file, re-read when it changes |
| `BOOKINGS_STORE=redis`, `REDIS_URL` | bookings | keep bookings in Redis |
| `BOOKING_REPEAT_SECONDS=600` | bookings | the same flight, hotel and nights within 10 minutes is one booking |

## How the pieces behave

- **Policy.** `k8s/policy-configmap.yaml` holds one `tool_name kind` per
  line. It is mounted as a file in the host and the gateway. Both use the
  same function, `host/policy.py`, which re-reads the file when its
  modification time changes. An edit reached the pods in 2 to 11 s. If the
  file cannot be read, nothing is allowed.
- **Gateway.** Forwards `/flights/mcp`, `/hotels/mcp` and `/bookings/mcp`
  with all headers. A `tools/call` for a tool that is not on the list is
  answered by the gateway with a tool error; the server never sees it. The
  host checks the same list first, so on stage the red row comes from the
  host and the gateway is the second lock. It adds about 5 ms per call.
  One marked comment shows where a token check would go.
- **Bookings.** Two replicas, state in Redis (`booking:<id>`). Redis has no
  disk, so bookings are lost when the Redis pod restarts. Deleting a
  bookings pod loses nothing.

## When it goes wrong

- `ctr: content digest ... not found` on import: use `build_image.sh`, not
  `k3d image import` (explained in the script).
- The image build is slow or fails in pip: it does not use the network.
  `build_image.sh` fills `deploy/wheels/` first; run that script, not
  `docker build` by hand, the first time.
- Host pod restarts once or twice after `up.sh`: it starts before the
  gateway is ready and Kubernetes starts it again. `up.sh` waits for it.
- Changed Python code: `deploy/build_image.sh`, then
  `kubectl -n safiri rollout restart deploy/host deploy/gateway deploy/flights deploy/hotels deploy/bookings`.
- A policy edit does not arrive: `kubectl -n safiri rollout restart deploy/gateway deploy/host`.

## Not built

The token check at the gateway (Phase 5), the Fooled LLM scene and the
turn-level wire chapters are out of scope for Demo 2.
