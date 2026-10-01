#!/usr/bin/env bash
# Playwright's WebKit is built for Ubuntu 24.04 and does not start on Arch
# (libicudata.so.74, libxml2.so.2, libjxl.so.0.8, flite, ...). Run the WebKit
# projects in Microsoft's Playwright image instead, locked down: rootless
# podman when it is installed, no capabilities, no new privileges, no host
# network, a read-only root, and the image pinned by digest.
set -euo pipefail
cd "$(dirname "$0")/.."

PLAYWRIGHT_VERSION=1.62.1
IMAGE="mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e"

locked="$(node -p "require('./package-lock.json').packages['node_modules/playwright-core'].version")"
if [ "$locked" != "$PLAYWRIGHT_VERSION" ]; then
  echo "package-lock.json has Playwright $locked, and $0 pins $PLAYWRIGHT_VERSION. Update PLAYWRIGHT_VERSION and the digest from: podman pull mcr.microsoft.com/playwright:v${locked}-noble" >&2
  exit 1
fi

if command -v podman >/dev/null; then
  engine=(podman run --userns=keep-id)
elif command -v docker >/dev/null; then
  engine=(docker run --user "$(id -u):$(id -g)")
else
  echo "WebKit needs podman (preferred, rootless) or docker." >&2
  exit 1
fi

exec "${engine[@]}" --rm --init \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --read-only --tmpfs /tmp:exec --shm-size=1g --pids-limit=4096 \
  -e HOME=/tmp \
  -v "$PWD:/work" -w /work \
  "$IMAGE" \
  npx playwright test --project=security-webkit --project=lifecycle-webkit "$@"
