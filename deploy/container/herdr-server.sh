#!/bin/sh
# Runs herdr's headless server for the moshpit container's herdr service.
# herdr keeps its config under $HOME/.config/herdr and its state under
# $XDG_STATE_HOME/herdr. Links put both on the /herdr volume, so the agents
# herdr starts keep their own XDG directories in /agent-home.
set -eu

link() {
  target=$1
  name=$2
  mkdir -p "$target" "$(dirname "$name")"
  if [ -L "$name" ] || [ ! -e "$name" ]; then
    ln -sfn "$target" "$name"
  else
    echo "herdr-server: $name is a directory, not a link to $target. Move its contents to $target, remove it, then restart." >&2
    exit 1
  fi
}

link /herdr/config "$HOME/.config/herdr"
link /herdr/state "${XDG_STATE_HOME:-$HOME/.local/state}/herdr"
exec herdr server
