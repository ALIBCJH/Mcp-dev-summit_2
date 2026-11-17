#!/usr/bin/env bash
# Download k3d v5.9.0 to ~/.local/bin and verify its sha256 before use.
# The checksum is the one GitHub publishes for the release asset.
set -euo pipefail

VERSION=v5.9.0
SHA256=06d8f25bc3a971c4eb29e0ff08429b180402db0f4dec838c9eac427e296800a0
URL="https://github.com/k3d-io/k3d/releases/download/$VERSION/k3d-linux-amd64"
DEST="$HOME/.local/bin/k3d"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL -o "$tmp" "$URL"
echo "$SHA256  $tmp" | sha256sum --check --quiet
install -m 0755 "$tmp" "$DEST"
echo "installed: $("$DEST" version | head -1) at $DEST"
