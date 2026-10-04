#!/usr/bin/env bash
# Makes the previous image available to the job and records its reference as
# TIEHALL_PREVIOUS_IMAGE in $GITHUB_ENV (or prints it outside Actions), for the
# backup, upgrade and rollback tests (self-host-install: Backups with the
# shipped scripts; self-host-install: Upgrades apply migrations before the app
# starts): the image of the newest final release whose version tag the given
# commit holds, which the release workflow tags with its version, a release
# candidate such as v1.3.0-rc.1 being no release; or, before the first
# release, the image last built from main, which the Build workflow tags
# sha-<commit>: that of the given commit, or of its nearest first-parent
# ancestor whose build pushed one. The release workflow gives the parent of
# the release's commit, <commit>^, so the release's own tag is not among them.
# It needs the commit's history (a checkout with fetch-depth 0), and logs in to
# GHCR with the job's read-only package token when GHCR_TOKEN is set.
# Usage: tools/image-tests/get-previous-image.sh <commit>
set -euo pipefail
commit="${1:?Usage: get-previous-image.sh <commit>}"
owner="$(printf '%s' "${GITHUB_REPOSITORY_OWNER:?Set GITHUB_REPOSITORY_OWNER}" | tr '[:upper:]' '[:lower:]')"
repository="ghcr.io/$owner/tiehall"

release="$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --merged "$commit" --sort=-v:refname | { grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true; } | head -n 1)"
candidates=()
if [ -n "$release" ]; then
  candidates+=("$repository:${release#v}")
else
  while IFS= read -r ancestor; do candidates+=("$repository:sha-$ancestor"); done < <(git rev-list --first-parent --max-count=20 "$commit")
fi

if [ -n "${GHCR_TOKEN:-}" ]; then
  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin
fi
found=""
for candidate in "${candidates[@]}"; do
  if docker pull --quiet "$candidate" > /dev/null 2>&1; then
    found="$candidate"
    break
  fi
done
if [ -n "${GHCR_TOKEN:-}" ]; then docker logout ghcr.io; fi
if [ -z "$found" ]; then
  echo "No previous image found: none of ${candidates[*]:-no candidate} could be pulled." >&2
  exit 1
fi
if [ -n "${GITHUB_ENV:-}" ]; then echo "TIEHALL_PREVIOUS_IMAGE=$found" >> "$GITHUB_ENV"; else echo "TIEHALL_PREVIOUS_IMAGE=$found"; fi
