# The Tiehall image: one image with four roles, web, worker, migrate and all
# (design.md decision 1; operations: Production runs the self-host Compose file
# and image). Build it from the repository root:
#   docker build --build-arg TIEHALL_COMMIT_SHA="$(git rev-parse HEAD)" --tag tiehall .
# and run a role on a read-only root filesystem:
#   docker run --read-only --tmpfs /tmp --env DATABASE_URL=postgres://... tiehall web
# Configuration comes only from environment variables and *_FILE secrets.

# Node 24 LTS, pinned by digest. Renovate proposes a new digest only after the
# 7-day release age, through a reviewed pull request.
FROM node:24.21.0-trixie-slim@sha256:d7b4e5c4ad20b327d7bb16fab6aecd60ac20aa50f8514eb75a2b059e89abe48e AS base

FROM base AS build
ENV CI=true NEXT_TELEMETRY_DISABLED=1
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
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    TIEHALL_COMMIT_SHA=${TIEHALL_COMMIT_SHA}
LABEL org.opencontainers.image.title="tiehall" \
      org.opencontainers.image.description="Tiehall: one image with the roles web, worker, migrate and all" \
      org.opencontainers.image.revision="${TIEHALL_COMMIT_SHA}"
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
