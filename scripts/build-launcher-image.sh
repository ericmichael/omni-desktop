#!/usr/bin/env bash
# Build (and optionally push) the launcher server image with the omni-code
# version sourced from src/lib/omni-version.ts — the single pin location.
#
# Usage:
#   scripts/build-launcher-image.sh <image-ref> [--push]
# Example:
#   scripts/build-launcher-image.sh omnilauncheracr.azurecr.io/omni-launcher:latest --push
#
# OMNI_PIP_INDEX overrides the (public) package index for the baked pipx install.
set -euo pipefail

IMAGE="${1:?usage: build-launcher-image.sh <image-ref> [--push]}"
PUSH="${2:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OMNI_PIP_INDEX="${OMNI_PIP_INDEX:-https://pypi.fury.io/ericmichael/}"

OMNI_CODE_VERSION="$(node "$HERE/omni-code-version.mjs")"
echo "Building $IMAGE with omni-code==$OMNI_CODE_VERSION (from src/lib/omni-version.ts)"

docker build \
  -t "$IMAGE" \
  --build-arg "OMNI_CODE_VERSION=$OMNI_CODE_VERSION" \
  --build-arg "OMNI_PIP_INDEX=$OMNI_PIP_INDEX" \
  "$ROOT"

if [[ "$PUSH" == "--push" ]]; then
  echo "Pushing $IMAGE"
  docker push "$IMAGE"
fi
