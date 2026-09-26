# Proposal: `init --image`

## Why

The self-host-install spec asks two things of `init` that no container can do at once. `TIEHALL_IMAGE` in the printed `.env` is pinned by version and digest, so an install runs exactly the image a release published. And `init --url` alone prints a file that starts an install without further edits. A container cannot see the image it was started from, and an image's digest exists only after the image is built, so `init` cannot learn its own digest. The code built under the main change's task 5.2 already takes an optional `--image`, ahead of the spec; the spec did not say so, and did not say what `init` writes without it.

D42 settles it, as [design.md](design.md#decisions-this-change-rests-on) restates: `init` takes an optional `--image <reference>`, pins the digest only when given one, which the install command in the release notes includes, and otherwise writes the version tag it was built with and a comment that says where the digest comes from. The printed file starts an install unedited either way, which keeps D36 as the main change reads it.

## What Changes

- `init` accepts `--image <reference>` and writes the reference into `TIEHALL_IMAGE` verbatim. A value that is not an image reference is refused with a clear message and a non-zero exit, and no `.env` is printed.
- Without `--image`, `TIEHALL_IMAGE` is the image's own name and version tag, which the build bakes into the image, and the printed file says at that line that the release notes name the digest, and how to pin it.
- The install command in the release notes carries `--image` with the release's reference pinned by version and digest. `.env.example` and the Compose file show the same command.
- The `.env` rule for `TIEHALL_IMAGE` now reads: pinned by version always, and by digest as well when the reference carries one.
- Each run still generates fresh secrets, with or without `--image`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `self-host-install`: the requirement on `init` and the requirement that lists the `.env` settings.

## Impact

- **Code:** `apps/server` (the `init` role and the `.env` writer), the image tests and the boot test, `deploy/.env.example` and the header of `deploy/compose.yaml`. The Dockerfile and the build workflow already bake the image name and the commit into the image; the release workflow, when the main change builds it, passes the release's version the same way.
- **Public contracts:** `init` gains one option. What it printed before keeps its shape, and the `.env` keys are unchanged.
- **Docs:** the install docs and the release notes, which the main change writes later, show the install command with `--image`.
- **Ordering:** this change is archived after `add-tiehall-oss-v1`, whose `self-host-install` spec it modifies.
