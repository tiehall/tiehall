# The step installs a package the base image does not carry, so the image's
# package set drifts from the base image's without review.
FROM node:24.21.0-trixie-slim AS base

FROM base AS build
WORKDIR /repo
COPY . .
RUN npm ci && npm run build

FROM base
RUN export DEBIAN_FRONTEND=noninteractive \
    && apt-get update --error-on=any \
    && apt-get upgrade --yes --no-install-recommends \
    && apt-get install --yes --no-install-recommends curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --from=build /repo/dist/ ./
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/node", "/app/main.js"]
