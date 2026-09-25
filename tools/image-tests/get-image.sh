#!/usr/bin/env bash
# Makes the image under test available to the job and records its reference as
# TIEHALL_IMAGE in $GITHUB_ENV (or prints it outside Actions). With an image
# reference, it pulls that image, logging in to GHCR with the job's read-only
# package token when GHCR_TOKEN is set; without one, it builds the checked-out
# commit, as on a pull request.
# Usage: tools/image-tests/get-image.sh [image@sha256:digest]
set -euo pipefail
image="${1:-}"
if [ -n "$image" ]; then
  if [ -n "${GHCR_TOKEN:-}" ]; then
    printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin
  fi
  docker pull --quiet "$image"
  if [ -n "${GHCR_TOKEN:-}" ]; then docker logout ghcr.io; fi
else
  image=tiehall:ci
  docker build --build-arg TIEHALL_COMMIT_SHA="${GITHUB_SHA:-$(git rev-parse HEAD)}" --tag "$image" .
fi
if [ -n "${GITHUB_ENV:-}" ]; then echo "TIEHALL_IMAGE=$image" >> "$GITHUB_ENV"; else echo "TIEHALL_IMAGE=$image"; fi
