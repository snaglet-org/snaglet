#!/usr/bin/env bash
# Build and run the system-wide agent ask window (macOS, dev).
#   ask-overlay/run.sh start [ask-overlay-url]
#   ask-overlay/run.sh stop
# The window is shown only while an ask is pending; `stop` (or the menu-bar "?"
# item's Quit) removes it at any time.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
bin="${TMPDIR:-/tmp}/snaglet-ask-overlay"
cmd="${1:-start}"

case "$cmd" in
  start)
    ui="${2:-http://localhost:${CLIENT_PORT:-3001}/?askOverlay=1}"
    pkill -f "$bin" 2>/dev/null || true
    sdk="${SNAGLET_SWIFT_SDK:-/Library/Developer/CommandLineTools/SDKs/MacOSX26.sdk}"
    swiftc -O -sdk "$sdk" "$here/AskOverlay.swift" -o "$bin"
    nohup "$bin" "$ui" >/dev/null 2>&1 &
    echo "ask overlay running (pid $!) -> $ui"
    echo "stop it any time: $0 stop  (or the menu-bar ? > Quit)"
    ;;
  stop)
    pkill -f "$bin" 2>/dev/null && echo "stopped" || echo "not running"
    ;;
  *)
    echo "usage: $0 start [ask-overlay-url] | stop" >&2; exit 2 ;;
esac
