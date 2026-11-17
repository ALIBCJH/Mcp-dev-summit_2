#!/usr/bin/env bash
# Is Demo 2 ready for the stage? One line per check, green or red, in
# under 20 seconds. Exit code 0 only when everything is green.
#
#   deploy/preflight.sh
set -uo pipefail
cd "$(dirname "$0")/.."
export KUBECONFIG=deploy/kubeconfig.yaml
NS=safiri
NODE=k3d-safiri-server-0
K="kubectl --request-timeout=5s"
failed=0

ok()  { printf '\033[32m  OK   %s\033[0m\n' "$1"; }
bad() { printf '\033[31m  FAIL %s\033[0m\n         fix: %s\n' "$1" "$2"; failed=1; }
check() { # description, fix, command...
  local what="$1" fix="$2"; shift 2
  if "$@" >/dev/null 2>&1; then ok "$what"; else bad "$what" "$fix"; fi
}

ready() { # deployment wanted-replicas
  [ "$($K -n $NS get deploy "$1" -o jsonpath='{.status.readyReplicas}')" = "$2" ]
}
policy_complete() { # all five tools on the list inside the pod
  [ "$($K -n $NS exec "deploy/$1" -- grep -c -E '^(search_flights|get_flight_status|search_hotels|book_trip|cancel_booking) ' /policy/policy.txt)" = "5" ]
}

check "kube context is k3d-safiri (deploy/kubeconfig.yaml)" "deploy/up.sh" \
  test "$(kubectl config current-context 2>/dev/null)" = "k3d-safiri"
check "cluster node is Ready" "deploy/up.sh" \
  $K wait --for=condition=Ready node --all --timeout=5s
check "image safiri:demo2 is in the node" "deploy/build_image.sh" \
  sh -c "docker exec $NODE crictl images | grep -q 'library/safiri .*demo2'"
check "image redis:7-alpine is in the node" "deploy/build_image.sh" \
  sh -c "docker exec $NODE crictl images | grep -q 'library/redis .*7-alpine'"
check "secret safiri-api holds ANTHROPIC_API_KEY" "deploy/up.sh" \
  sh -c "$K -n $NS get secret safiri-api -o jsonpath='{.data.ANTHROPIC_API_KEY}' | grep -q ."
for pair in redis:1 flights:1 hotels:1 bookings:2 gateway:1 host:1; do
  check "pods ready: ${pair%%:*} (${pair##*:})" "kubectl -n $NS get pods; kubectl -n $NS logs deploy/${pair%%:*}" \
    ready "${pair%%:*}" "${pair##*:}"
done
check "Redis answers PING" "kubectl -n $NS rollout restart deploy/redis" \
  sh -c "$K -n $NS exec deploy/redis -- redis-cli ping | grep -q PONG"
check "policy has all five tools (host)" "kubectl apply -f deploy/k8s/policy-configmap.yaml, wait 15 s" \
  policy_complete host
check "policy has all five tools (gateway)" "kubectl apply -f deploy/k8s/policy-configmap.yaml, wait 15 s" \
  policy_complete gateway
check "Safiri answers on http://127.0.0.1:8080/" "kubectl -n $NS logs deploy/host" \
  sh -c "curl -s --max-time 4 http://127.0.0.1:8080/api/state | grep -q '\"startup_done\":true'"
# Two tries of 5 s: on a slow venue link the first connection can time out.
check "Anthropic API is reachable from this laptop" "check the network; it is the only thing Safiri needs from outside" \
  sh -c "curl -s -o /dev/null --max-time 5 https://api.anthropic.com/ || curl -s -o /dev/null --max-time 5 https://api.anthropic.com/"

available_mb="$(free -m | awk '/^Mem:/ {print $7}')"
if [ "$available_mb" -ge 1000 ]; then ok "memory available: ${available_mb} MiB"
else bad "memory available: ${available_mb} MiB (want 1000 or more)" "close VS Code and extra Chrome tabs"; fi

echo
if [ "$failed" = 0 ]; then printf '\033[32mREADY\033[0m\n'; else printf '\033[31mNOT READY\033[0m\n'; fi
exit "$failed"
