#!/usr/bin/env bash
# How long after `kubectl apply` of the policy ConfigMap does the mounted
# file change inside the gateway and host pods? Also times the fallback,
# `kubectl rollout restart deploy/gateway`.
#
#   deploy/checks/reload_timing.sh [rounds]      (default 5)
#
# Each round adds a comment line to the policy (comments change nothing in
# the allow-list) and polls both pods until they see it. The original
# ConfigMap is put back at the end.
set -euo pipefail
cd "$(dirname "$0")/../.."
export KUBECONFIG=deploy/kubeconfig.yaml
ROUNDS="${1:-5}"
NS=safiri

now() { date +%s.%N; }

seen_after() { # deployment marker start-time -> seconds until the pod's file holds the marker
  local deploy="$1" marker="$2" start="$3"
  while ! kubectl -n "$NS" exec "deploy/$deploy" -- grep -q "$marker" /policy/policy.txt 2>/dev/null; do
    sleep 0.5
  done
  echo "$(now) - $start" | bc
}

trap 'kubectl apply -f deploy/k8s/policy-configmap.yaml >/dev/null; echo "policy ConfigMap restored"' EXIT

echo "round  gateway_s  host_s"
for round in $(seq 1 "$ROUNDS"); do
  marker="reload-test-$round-$RANDOM"
  sed "s/^    search_flights .*/&\n    # $marker/" deploy/k8s/policy-configmap.yaml | kubectl apply -f - >/dev/null
  start="$(now)"
  seen_after gateway "$marker" "$start" > /tmp/reload_gateway.$$ &
  seen_after host "$marker" "$start" > /tmp/reload_host.$$ &
  wait
  printf "%-6s %-10.1f %-6.1f\n" "$round" "$(cat /tmp/reload_gateway.$$)" "$(cat /tmp/reload_host.$$)"
  rm -f /tmp/reload_gateway.$$ /tmp/reload_host.$$
  # A random pause, so the rounds do not line up with the kubelet's own clock.
  sleep "$((RANDOM % 7 + 1))"
done

echo
echo "fallback: kubectl rollout restart deploy/gateway"
start="$(now)"
kubectl -n "$NS" rollout restart deploy/gateway >/dev/null
kubectl -n "$NS" rollout status deploy/gateway --timeout=120s >/dev/null
printf "new gateway pod ready after %.1f s\n" "$(echo "$(now) - $start" | bc)"
