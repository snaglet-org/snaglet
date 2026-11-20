#!/usr/bin/env bash
# Build the Snaglet Apple TTS sidecar. macOS-only (needs swiftc + AVFoundation).
# Emits a single self-contained binary to bin/snaglet-apple-tts (gitignored).
#
#   ./build.sh            # release build (-O)
#   SNAGLET_TTS_DEBUG=1 ./build.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="$here/bin/snaglet-apple-tts"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "[apple-tts] not macOS — skipping build (piper TTS is the default engine)" >&2
  exit 0
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "[apple-tts] swiftc not found — install Xcode command line tools to build" >&2
  exit 1
fi

source "$here/../macos-sdk.sh"
sdk="$(snaglet_macos_sdk)"
mkdir -p "$here/bin"
opt="-O"
[[ "${SNAGLET_TTS_DEBUG:-}" == "1" ]] && opt="-Onone -g"
deployment_target="${MACOSX_DEPLOYMENT_TARGET:-14.0}"
target="$(uname -m)-apple-macos${deployment_target}"

echo "[apple-tts] compiling tts.swift → bin/snaglet-apple-tts ($opt, target $target)" >&2
# shellcheck disable=SC2086
swiftc $opt -sdk "$sdk" -target "$target" -framework AVFoundation -o "$out" "$here/tts.swift"
echo "[apple-tts] built $out" >&2
