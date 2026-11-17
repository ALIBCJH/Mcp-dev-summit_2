#!/usr/bin/env bash
# Stop Demo 2 and free its memory. The cluster is stopped, not deleted, so
# the images stay inside the node and deploy/up.sh brings it back quickly.
#
#   deploy/down.sh            stop (use this after a rehearsal)
#   deploy/down.sh --delete   remove the cluster completely
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--delete" ]; then
  k3d cluster delete safiri
  rm -f deploy/kubeconfig.yaml
  echo "cluster deleted. deploy/up.sh will rebuild it (needs the images in Docker)."
else
  k3d cluster stop safiri
  echo "cluster stopped. deploy/up.sh starts it again."
fi
