# syntax=docker/dockerfile:1.7
# The published felix-gateway image, serving the built web page from the same
# origin as /ws, with the canvas's scope file.
# Build from the repository root: docker build -f docker/gateway.Dockerfile .

ARG GATEWAY_VERSION=0.3.2

FROM node:24-trixie-slim AS web
WORKDIR /src
# Every workspace's manifest, or npm ci refuses the lockfile.
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY model/package.json model/
COPY web/package.json web/
COPY snapshotter/package.json snapshotter/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include-workspace-root -w @felix-canvas/model -w @felix-canvas/web
COPY model model
COPY web web
RUN npm run build -w @felix-canvas/model && npm run build -w @felix-canvas/web

FROM ghcr.io/getfelix/felix-gateway:${GATEWAY_VERSION}
# openssl so the compose install can make the broker a certificate with this image.
USER 0:0
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
USER 65532:65532
COPY --from=web /src/web/dist /usr/share/felix-canvas/web
COPY deploy/scope.toml /etc/felix-gateway/scope.toml
ENV GATEWAY_WEB_DIR=/usr/share/felix-canvas/web \
    GATEWAY_TENANT=canvas \
    GATEWAY_OIDC_CLIENT_ID=felix-canvas
