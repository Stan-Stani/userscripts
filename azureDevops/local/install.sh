#!/usr/bin/env bash
# Sets up the ADO Toolbox's local side on this Mac (see README.md here):
#
#   azureDevops/local/install.sh [--with-review-sync]
#
# Links ado-companion, pr-review-sync and cc-pr into ~/.local/bin, and ccpr.lua into
# ~/.hammerspoon when Hammerspoon is installed (an existing ccpr.lua is kept as
# ccpr.lua.bak-<date>). Writes the launchd agent that keeps ado-companion running,
# plus the review-time sync (at login, then every 2 hours) with --with-review-sync,
# and (re)starts them.
# Writes ~/.config/ado-companion/config.json with empty settings if it's missing.
# Safe to rerun.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
bin=$HOME/.local/bin
agents=$HOME/Library/LaunchAgents
config=$HOME/.config/ado-companion/config.json
uid=$(id -u)

with_sync=""
for arg in "$@"; do
  case $arg in
    --with-review-sync) with_sync=1 ;;
    *) echo "usage: $0 [--with-review-sync]" >&2; exit 2 ;;
  esac
done

# A stable node: a version manager's per-shell path would vanish under launchd.
node=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -x "$candidate" ] && { node=$candidate; break; }
done
if [ -z "$node" ]; then
  node=$(command -v node || true)
  [ -n "$node" ] || { echo "install.sh: node not found" >&2; exit 1; }
  echo "install.sh: using $node; if it's a version manager's shim path, launchd may lose it" >&2
fi

mkdir -p "$bin" "$agents" "$HOME/.local/share/ado-companion" "$HOME/.local/share/pr-review" "$(dirname "$config")"
ln -sfn "$here/ado-companion.mjs" "$bin/ado-companion.mjs"
ln -sfn "$here/pr-review-sync" "$bin/pr-review-sync"
ln -sfn "$(cd "$here/.." && pwd)/cc-pr" "$bin/cc-pr"

if [ -d "$HOME/.hammerspoon" ]; then
  target=$HOME/.hammerspoon/ccpr.lua
  if [ -e "$target" ] && [ "$(readlink "$target" || true)" != "$here/ccpr.lua" ]; then
    mv "$target" "$target.bak-$(date +%Y%m%d%H%M%S)"
  fi
  ln -sfn "$here/ccpr.lua" "$target"
fi

if [ ! -e "$config" ]; then
  cat > "$config" <<'JSON'
{
  "org": "",
  "project": "",
  "fallbackRepo": "",
  "patEnvFile": "",
  "judgmentLogUrl": "",
  "claudeConfigDir": ""
}
JSON
  echo "install.sh: wrote $config; fill in org and project for /pr/<id>"
fi

# Writes a launchd agent from its template and (re)starts it.
agent() {
  local label=$1 plist=$agents/$1.plist
  sed -e "s#__NODE__#$node#g" -e "s#__HOME__#$HOME#g" "$here/launchd/$label.plist" > "$plist"
  plutil -lint "$plist" >/dev/null
  launchctl bootout "gui/$uid/$label" 2>/dev/null || true
  # Loading right after an unload can fail with "Input/output error" until
  # launchd has let go of the old job, so wait for that and retry.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    launchctl print "gui/$uid/$label" >/dev/null 2>&1 || break
    sleep 0.5
  done
  local tries=0
  until launchctl bootstrap "gui/$uid" "$plist" 2>/dev/null; do
    tries=$((tries + 1))
    [ "$tries" -lt 5 ] || { echo "install.sh: couldn't start $label (launchctl bootstrap gui/$uid $plist)" >&2; exit 1; }
    sleep 1
  done
  echo "install.sh: $label running from $plist"
}

agent com.ado-companion
[ -z "$with_sync" ] || agent com.ado-companion.pr-review-sync

cat <<'EOF'
Next:
  - Hammerspoon: in ~/.hammerspoon/init.lua, require("ccpr").setup{} (settings in ccpr.lua's header), then reload.
  - Check: curl -s http://127.0.0.1:47811/idle
EOF
