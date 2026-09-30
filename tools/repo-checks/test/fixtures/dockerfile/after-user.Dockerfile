# The updates come after the switch to the non-root user.
FROM node:24.21.0-trixie-slim AS base

FROM base AS build
WORKDIR /repo
COPY . .
RUN npm ci && npm run build

FROM base
WORKDIR /app
COPY --from=build /repo/dist/ ./
USER 1000:1000
RUN export DEBIAN_FRONTEND=noninteractive \
    && apt-get update \
    && apt-get upgrade --yes --no-install-recommends \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/local/bin/node", "/app/main.js"]
