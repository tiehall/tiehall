# The Tiehall image: one image with the roles web, worker, migrate, all and init
# (design.md, Technical decisions: T1; self-host-install: Tiehall's containers
# are confined). Build it from the repository root:
#   docker build --build-arg TIEHALL_COMMIT_SHA="$(git rev-parse HEAD)" --tag tiehall .
# and run a role on a read-only root filesystem:
#   docker run --read-only --tmpfs /tmp --env TIEHALL_URL=https://... --env TIEHALL_DATABASE_APP_URL=postgres://... ... tiehall web
# Its settings come only from environment variables and *_FILE secrets
# (self-host-install: One `.env` holds the install settings).

# Node 24 LTS, pinned by digest. Renovate proposes a new digest only after the
# 7-day release age, through a reviewed pull request.
FROM node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS base

FROM base AS build
# No framework telemetry at build time, and none at run time below (self-host-install: No telemetry and a
# documented list of outbound connections): neither Next.js's nor the sign-in library's.
ENV CI=true NEXT_TELEMETRY_DISABLED=1 BETTER_AUTH_TELEMETRY=0
WORKDIR /repo
# pnpm, at the version in package.json "packageManager", without install scripts.
COPY package.json ./
RUN npm install --global --ignore-scripts "$(node -p 'require("./package.json").packageManager')"
# Every package the lockfile names, fetched before the sources are copied, so
# this layer is reused until the lockfile changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline --filter "@tiehall/web..." --filter "@tiehall/server..."
# The commit becomes the Next.js deploymentId, so a browser still on an older
# release reloads instead of mixing versions during a rolling release.
ARG TIEHALL_COMMIT_SHA
RUN test -n "$TIEHALL_COMMIT_SHA" || { echo "Build with --build-arg TIEHALL_COMMIT_SHA=<commit>" >&2; exit 1; }
RUN pnpm --filter @tiehall/web build && pnpm --filter @tiehall/server build

FROM base
# The app needs only node at run time: remove the package managers the base
# image ships, so nothing in a running container can fetch and install code.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
ARG TIEHALL_COMMIT_SHA
# The release this image is, such as 1.4.0; the release workflow sets it from the version tag, and any other
# build is a development build. The migrate role records it with each migration (the schema floor).
ARG TIEHALL_VERSION=0.0.0-dev
# The repository the image is pushed to, which the init role names in the .env it prints, tagged with the
# release, or with sha-<commit> for a development build, as the build workflow tags it.
ARG TIEHALL_IMAGE_NAME=tiehall
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    BETTER_AUTH_TELEMETRY=0 \
    TIEHALL_COMMIT_SHA=${TIEHALL_COMMIT_SHA} \
    TIEHALL_VERSION=${TIEHALL_VERSION} \
    TIEHALL_IMAGE_NAME=${TIEHALL_IMAGE_NAME}
LABEL org.opencontainers.image.title="tiehall" \
      org.opencontainers.image.description="Tiehall: one image with the roles web, worker, migrate, all and init" \
      org.opencontainers.image.revision="${TIEHALL_COMMIT_SHA}" \
      org.opencontainers.image.version="${TIEHALL_VERSION}"
WORKDIR /app
# The files stay owned by root, so the app cannot change its own code even
# where the root filesystem is writable.
COPY --from=build /repo/apps/web/.next/standalone/ ./
COPY --from=build /repo/apps/web/.next/static/ ./apps/web/.next/static/
COPY --from=build /repo/apps/server/dist/ ./apps/server/dist/
# The migrations the migrate role applies, where it looks for them: beside the bundle, as in the repository.
COPY --from=build /repo/packages/db/migrations/ ./packages/db/migrations/
# The base image's unprivileged "node" user, by number.
USER 1000:1000
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/node", "--enable-source-maps", "/app/apps/server/dist/main.mjs"]
