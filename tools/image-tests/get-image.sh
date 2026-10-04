#!/usr/bin/env bash
# Makes the image under test available to the job and records its reference as
# TIEHALL_IMAGE in $GITHUB_ENV (or prints it outside Actions). With IMAGE_ARCHIVE
# naming a saved image, such as the image the release workflow built for a
# release, it loads that image and tests it by the name it was saved with; with
# an image reference, it pulls that image, logging in to GHCR with the job's
# read-only package token when GHCR_TOKEN is set; with neither, it builds the
# checked-out commit, as on a pull request.
# Usage: [IMAGE_ARCHIVE=path/to/image.tar] tools/image-tests/get-image.sh [image@sha256:digest]
set -euo pipefail
image="${1:-}"
if [ -n "${IMAGE_ARCHIVE:-}" ]; then
  image="$(docker load --input "$IMAGE_ARCHIVE" | sed -n 's/^Loaded image: //p' | tail -n 1)"
  if [ -z "$image" ]; then
    echo "The saved image $IMAGE_ARCHIVE names no image." >&2
    exit 1
  fi
elif [ -n "$image" ]; then
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
