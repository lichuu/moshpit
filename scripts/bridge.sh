#!/usr/bin/env bash
# One entry point for running the moshpit bridge on a host.
#
#   scripts/bridge.sh init      write deploy/bridge.env from this machine's Tailscale identity
#   scripts/bridge.sh serve     point Tailscale Serve at the bridge port
#   scripts/bridge.sh run       build the SPA if stale, then run the bridge in the foreground
#   scripts/bridge.sh install   install and start the user service, so it survives logout and reboot
#   scripts/bridge.sh uninstall stop and remove the service; run leaves no trace behind
#   scripts/bridge.sh status    where the bridge is listening, what Serve publishes, whether it answers
#   scripts/bridge.sh logs      follow the service log
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE=$ROOT/deploy/bridge.env
UNIT=moshpit-bridge.service
UNIT_FILE=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT
HTTPS_PORT=${MOSHPIT_SERVE_PORT:-8803}

die() { echo "$*" >&2; exit 1; }

load_env() {
  [ -f "$ENV_FILE" ] || die "No $ENV_FILE. Run: scripts/bridge.sh init"
  set -a; . "$ENV_FILE"; set +a
}

# The SPA is served straight off disk by the bridge, so a stale dist/spa is
# the difference between deploying a change and only thinking you did.
build_if_stale() {
  local stamp=$ROOT/dist/spa/index.html
  if [ ! -f "$stamp" ] || [ -n "$(find "$ROOT/src" "$ROOT/index.html" "$ROOT/vite.spa.ts" "$ROOT/package.json" -newer "$stamp" -print -quit 2>/dev/null)" ]; then
    echo "Building dist/spa..."
    (cd "$ROOT" && npm run build:spa >/dev/null) || die "Build failed. Run npm run build:spa to see why."
  fi
}

cmd_init() {
  [ -f "$ENV_FILE" ] && die "$ENV_FILE already exists. Edit it, or delete it to start over."
  command -v tailscale >/dev/null || die "tailscale is not installed; copy deploy/bridge.env.example by hand instead."
  local dns login herdr
  dns=$(tailscale status --json | sed -n 's/.*"DNSName": *"\([^"]*\)".*/\1/p' | head -1 | sed 's/\.$//')
  login=$(tailscale status --json | sed -n 's/.*"LoginName": *"\([^"]*\)".*/\1/p' | grep '@' | head -1)
  herdr=$(command -v herdr || echo /usr/bin/herdr)
  [ -n "$dns" ] || die "Could not read this machine's Tailscale DNS name. Is tailscaled up?"
  [ -n "$login" ] || die "Could not read your Tailscale login. Is tailscaled up?"
  mkdir -p "$(dirname "$ENV_FILE")"
  cat > "$ENV_FILE" <<EOF
MOSHPIT_AUTH_MODE=tailscale
MOSHPIT_TRUSTED_USER=$login
MOSHPIT_HERDR_BIN=$herdr
MOSHPIT_PORT=${MOSHPIT_PORT:-8801}
MOSHPIT_PUBLIC_ORIGIN=https://$dns:$HTTPS_PORT
MOSHPIT_ALLOWED_AUTHORITIES=$dns:$HTTPS_PORT
MOSHPIT_STATE_DIR=$ROOT/.moshpit-state
EOF
  echo "Wrote $ENV_FILE:"; sed 's/^/  /' "$ENV_FILE"
  echo
  echo "Next: scripts/bridge.sh serve && scripts/bridge.sh install"
}

cmd_serve() {
  load_env
  command -v tailscale >/dev/null || die "tailscale is not installed."
  tailscale serve --bg --https "$HTTPS_PORT" "http://127.0.0.1:${MOSHPIT_PORT:-8801}"
  echo "Serve now publishes $MOSHPIT_PUBLIC_ORIGIN"
}

cmd_run() {
  load_env
  build_if_stale
  exec node "$ROOT/bridge/index.mjs"
}

cmd_install() {
  load_env
  build_if_stale
  local node_bin
  node_bin=$(command -v node) || die "node is not on PATH."
  mkdir -p "$(dirname "$UNIT_FILE")"
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=moshpit bridge
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
EnvironmentFile=$ENV_FILE
ExecStart=$node_bin $ROOT/bridge/index.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT"
  # Without lingering the service dies with the login session, which is the
  # usual reason the bridge is gone after a reboot.
  loginctl enable-linger "$USER" 2>/dev/null || echo "Note: could not enable lingering; the service will stop when you log out."
  systemctl --user --no-pager status "$UNIT" | head -5
}

cmd_uninstall() {
  systemctl --user disable --now "$UNIT" 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload
  echo "Removed $UNIT. Lingering and the Serve config are left alone; run scripts/bridge.sh run to start in the foreground."
}

cmd_status() {
  local port=8801
  [ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; port=${MOSHPIT_PORT:-8801}; }
  echo "== service =="
  systemctl --user is-active "$UNIT" 2>/dev/null || echo "not installed as a service"
  echo "== listening on $port =="
  ss -tlnp 2>/dev/null | grep ":$port " || echo "nothing is listening on $port"
  echo "== tailscale serve =="
  tailscale serve status 2>/dev/null || echo "no serve config"
  echo "== health =="
  # The bridge refuses a GET that carries neither an Origin nor same-origin
  # fetch metadata, so probe it the way the app does rather than bare.
  if [ -n "${MOSHPIT_PUBLIC_ORIGIN:-}" ] && [ -n "${MOSHPIT_ALLOWED_AUTHORITIES:-}" ]; then
    curl -fsS -m 5 -H "Host: ${MOSHPIT_ALLOWED_AUTHORITIES%%,*}" -H "Origin: $MOSHPIT_PUBLIC_ORIGIN" \
      "http://127.0.0.1:$port/api/auth-info" && echo || echo "the bridge did not answer /api/auth-info"
  else
    echo "no $ENV_FILE, so there is no origin to probe with"
  fi
}

cmd_logs() { journalctl --user -u "$UNIT" -f -n 50; }

case "${1:-run}" in
  init) cmd_init ;;
  serve) cmd_serve ;;
  run) cmd_run ;;
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  *) die "Usage: scripts/bridge.sh [init|serve|run|install|uninstall|status|logs]" ;;
esac
