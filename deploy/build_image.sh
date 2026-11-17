#!/usr/bin/env bash
# Build the one Safiri image and copy it, with Redis, into the k3d node.
# After this the cluster needs no registry and no network for images.
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. Fetch the pinned packages once into deploy/wheels. pip keeps its own
#    cache, so a second run needs almost no network. The laptop and the
#    image are both Python 3.12 on x86_64 Linux, so the same wheels fit.
.venv/bin/pip download --quiet --timeout 60 --retries 8 \
  -r requirements.txt -r deploy/requirements-k8s.txt -d deploy/wheels

# 2. Build. pip inside the build installs from deploy/wheels only.
docker build -f deploy/Dockerfile -t safiri:demo2 .

# 3. Copy the images into the cluster node. Not `k3d image import`: with
#    Docker's containerd image store it saves every platform's manifest and
#    the node then fails with "content digest ... not found". Saving one
#    platform and piping it into the node's containerd works.
for image in safiri:demo2 redis:7-alpine; do
  echo "importing $image"
  docker save --platform linux/amd64 "$image" \
    | docker exec -i k3d-safiri-server-0 ctr -n k8s.io images import --platform linux/amd64 - >/dev/null
done
docker exec k3d-safiri-server-0 crictl images | grep -E 'safiri|redis'
