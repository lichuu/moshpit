# syntax=docker/dockerfile:1
#
# The moshpit agent host image: the release executable, herdr and the
# tailscale CLI on a glibc base, running as the unprivileged user moshpit
# (uid 10001). Agent CLIs are not included; see Dockerfile.agents.
#
# Build from the repository root. The build runs git describe, so the
# context must be a full clone (not a worktree or a shallow clone):
#
#   docker buildx build -f deploy/container/Dockerfile \
#     --platform linux/amd64,linux/arm64 -t moshpit .

# node:26-bookworm-slim
ARG NODE_IMAGE=node:26-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2
# debian:bookworm-slim
ARG BASE_IMAGE=debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
# tailscale/tailscale:v1.102.5, the same image the Compose sidecar runs
ARG TAILSCALE_IMAGE=tailscale/tailscale:v1.102.5@sha256:c507f3a2a6ab1cabd8d809b98edeb41edbd5c3fb6ad9632ffd098b4c7d0b4065

FROM ${TAILSCALE_IMAGE} AS tailscale

# The single executable embeds the Node binary it was built with, so this
# stage runs on the target platform (under emulation for a foreign arch).
FROM ${NODE_IMAGE} AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:release \
 && install -m 0755 "dist/release/moshpit-linux-$(node -p process.arch)" /moshpit

# herdr from its GitHub release. Changing HERDR_VERSION means changing both
# checksums, which the release page lists beside each asset.
FROM ${BASE_IMAGE} AS herdr
ARG TARGETARCH
ARG HERDR_VERSION=0.9.1
ARG HERDR_SHA256_AMD64=2a02fed16beb651ef006e1d43f048f652ca4dc58ad053cd2d44450563d5c54b7
ARG HERDR_SHA256_ARM64=f4ccf4de745f2cb9a39a983e9ba3703dad50ec2a58dea83026ceab721bbd8d9e
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) asset=herdr-linux-x86_64; sum=$HERDR_SHA256_AMD64 ;; \
      arm64) asset=herdr-linux-aarch64; sum=$HERDR_SHA256_ARM64 ;; \
      *) echo "no herdr build for $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /herdr "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/${asset}"; \
    echo "$sum  /herdr" | sha256sum -c -; \
    chmod 0755 /herdr

FROM ${BASE_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --user-group --home-dir /agent-home --no-create-home --shell /bin/bash moshpit \
 && install -d -o moshpit -g moshpit -m 0700 /config /state /herdr /agent-home \
 && install -d -o moshpit -g moshpit -m 0755 /workspaces
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=herdr /herdr /usr/local/bin/herdr
COPY deploy/container/herdr-server.sh /usr/local/bin/herdr-server
COPY --from=build /moshpit /usr/local/bin/moshpit

# MOSHPIT_SUPERVISOR=container switches setup to container-supervised mode.
# Setup writes the config to MOSHPIT_CONFIG and its journal and the bridge
# state under $XDG_STATE_HOME/moshpit. The bridge reaches the herdr service
# through HERDR_SOCKET_PATH on the shared /herdr volume.
ENV MOSHPIT_SUPERVISOR=container \
    MOSHPIT_CONFIG=/config/config.json \
    XDG_STATE_HOME=/state \
    HERDR_SOCKET_PATH=/herdr/herdr.sock \
    HOME=/agent-home

USER moshpit
WORKDIR /workspaces
# /agent-home holds agent credentials. It is a secret: never share it with
# another container or back it up unencrypted.
VOLUME ["/config", "/state", "/herdr", "/workspaces", "/agent-home"]
ENTRYPOINT ["/usr/local/bin/moshpit"]
CMD ["bridge"]
