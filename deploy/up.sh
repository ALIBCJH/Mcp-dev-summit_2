#!/usr/bin/env bash
# Bring Demo 2 up. Safe to run again at any time: every step first checks
# whether it is already done.
#
#   deploy/up.sh        then open http://127.0.0.1:8080/
#
# Never touches your other kube contexts: it reads and writes only
# deploy/kubeconfig.yaml.
set -euo pipefail
cd "$(dirname "$0")/.."
export KUBECONFIG=deploy/kubeconfig.yaml
CLUSTER=safiri
NODE=k3d-safiri-server-0
NS=safiri

[ -f .env ] || { echo "No .env here. Copy it in first (it holds ANTHROPIC_API_KEY)."; exit 1; }

# 1. The cluster: create it the first time, start it if it was stopped.
if ! k3d cluster list "$CLUSTER" >/dev/null 2>&1; then
  echo "== creating cluster $CLUSTER"
  k3d cluster create "$CLUSTER" --image rancher/k3s:v1.35.5-k3s1 \
    --servers 1 --agents 0 --no-lb \
    --api-port 127.0.0.1:6550 \
    -p "127.0.0.1:8080:30080@server:0:direct" \
    --k3s-arg "--disable=traefik@server:0" \
    --k3s-arg "--disable=servicelb@server:0" \
    --k3s-arg "--disable=metrics-server@server:0" \
    --k3s-arg "--disable=local-storage@server:0" \
    --k3s-arg "--kubelet-arg=sync-frequency=10s@server:0" \
    --kubeconfig-update-default=false --kubeconfig-switch-context=false
elif [ "$(docker inspect -f '{{.State.Running}}' "$NODE")" != "true" ]; then
  echo "== starting cluster $CLUSTER"
  k3d cluster start "$CLUSTER"
fi
(umask 077; k3d kubeconfig get "$CLUSTER" > deploy/kubeconfig.yaml)
kubectl wait --for=condition=Ready node --all --timeout=120s >/dev/null

# 2. The images: build and import only when the node does not have them.
if ! docker exec "$NODE" crictl images | grep -q "library/safiri .*demo2"; then
  echo "== building and importing the image"
  deploy/build_image.sh
fi

# 3. The API key: a Secret made from .env. The value is never printed; it
#    goes from the file through a pipe into the cluster.
kubectl apply -f deploy/k8s/namespace.yaml >/dev/null
kubectl -n "$NS" create secret generic safiri-api --from-env-file=.env \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
echo "Claude API key in the cluster: yes"

# 4. Everything else, then wait until every pod is ready.
kubectl apply -f deploy/k8s/ >/dev/null
for d in redis flights hotels bookings gateway host; do
  kubectl -n "$NS" rollout status "deploy/$d" --timeout=180s >/dev/null
  echo "ready: $d"
done

echo
echo "Safiri is up: http://127.0.0.1:8080/"
echo "Check everything: deploy/preflight.sh"
