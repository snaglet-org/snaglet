#!/usr/bin/env bash
# Build and run the system-wide agent cursor overlay (macOS, dev).
#   cursor-overlay/run.sh start [overlay-url] [api-url]
#   cursor-overlay/run.sh stop
# The overlay is click-through by construction; `stop` (or the menu-bar flower's
# Quit) removes it at any time.
set -euo pipefail
# The Snaglet server starts the overlay on its own when an agent claims the cursor;
# this script runs it by hand against a specific server.
here="$(cd "$(dirname "$0")/../../server/native/cursor-overlay" && pwd)"
bin="${TMPDIR:-/tmp}/snaglet-cursor-overlay"
cmd="${1:-start}"

case "$cmd" in
  start)
    # Packaged Snaglet: follow the running sidecar (random port + session token) unless
    # the caller passes URLs or a token. Dev servers keep the localhost defaults.
    session="${SNAGLET_HOME:-$HOME/.snaglet}/runtime/desktop-cli-session.json"
    sidecar=""
    if [ -z "${2:-}" ] && [ -f "$session" ]; then
      sidecar="$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("serverUrl",""))' "$session" 2>/dev/null || true)"
      if [ -n "$sidecar" ] && [ -z "${SNAGLET_AUTH_TOKEN:-}" ]; then
        SNAGLET_AUTH_TOKEN="$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("sidecarToken",""))' "$session" 2>/dev/null || true)"
        export SNAGLET_AUTH_TOKEN
      fi
    fi
    ui="${2:-${sidecar:+$sidecar/?cursorOverlay=1}}"
    ui="${ui:-http://localhost:${CLIENT_PORT:-3001}/?cursorOverlay=1}"
    api="${3:-${sidecar:-http://localhost:${PORT:-4001}}}"
    pkill -f "$bin" 2>/dev/null || true
    # The CLT default SDK can be newer than its compiler; pin a matching one.
    sdk="${SNAGLET_SWIFT_SDK:-/Library/Developer/CommandLineTools/SDKs/MacOSX26.sdk}"
    swiftc -O -sdk "$sdk" "$here/CursorOverlay.swift" -o "$bin"
    # SNAGLET_AUTH_TOKEN (if set in the caller's environment) is inherited by the overlay
    # for the kill-switch request; it is never put on the command line.
    nohup "$bin" "$ui" "$api" >/dev/null 2>&1 &
    echo "cursor overlay running (pid $!) -> $ui"
    echo "stop it any time: $0 stop  (or the menu-bar flower > Quit)"
    ;;
  stop)
    pkill -f "$bin" 2>/dev/null && echo "stopped" || echo "not running"
    ;;
  *)
    echo "usage: $0 start [overlay-url] [api-url] | stop" >&2; exit 2 ;;
esac
