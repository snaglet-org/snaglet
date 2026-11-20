#!/usr/bin/env bash
# Build the Snaglet system-wide agent cursor overlay. macOS-only (swiftc + Cocoa/WebKit).
# Emits a single binary to bin/snaglet-cursor-overlay (gitignored). The server spawns it
# when an agent claims the cursor (services/systemCursorOverlayLauncher.ts).
#
#   ./build.sh            # release build (-O)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="$here/bin/snaglet-cursor-overlay"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "[cursor-overlay] not macOS — skipping build (flowers stay inside the Snaglet window)" >&2
  exit 0
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "[cursor-overlay] swiftc not found — install Xcode command line tools to build" >&2
  exit 1
fi

source "$here/../macos-sdk.sh"
sdk="$(snaglet_macos_sdk)"
mkdir -p "$here/bin"
deployment_target="${MACOSX_DEPLOYMENT_TARGET:-14.0}"
target="$(uname -m)-apple-macos${deployment_target}"

echo "[cursor-overlay] compiling CursorOverlay.swift → bin/snaglet-cursor-overlay (target $target)" >&2
swiftc -O -sdk "$sdk" -target "$target" -o "$out" "$here/CursorOverlay.swift"
echo "[cursor-overlay] built $out" >&2
