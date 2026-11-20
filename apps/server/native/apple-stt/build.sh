#!/usr/bin/env bash
# Build the Snaglet Apple STT sidecar. macOS-only (needs swiftc + the macOS 26 SDK).
# Emits a single self-contained binary to bin/snaglet-apple-stt (gitignored).
#
#   ./build.sh            # release build (-O)
#   SNAGLET_STT_DEBUG=1 ./build.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="$here/bin/snaglet-apple-stt"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "[apple-stt] not macOS — skipping build (fallback STT engine is used)" >&2
  exit 0
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "[apple-stt] swiftc not found — install Xcode command line tools to build" >&2
  exit 1
fi

source "$here/../macos-sdk.sh"
sdk="$(snaglet_macos_sdk)"
# SpeechAnalyzer and SpeechTranscriber exist only from the macOS 26 SDK on.
# Keep in step with minimumSdk in apps/server/scripts/lib/nativeHelpers.mjs.
minimum_sdk=26
sdk_version="$(snaglet_macos_sdk_version "$sdk" 2>/dev/null || true)"
if [[ "$sdk_version" =~ ^([0-9]+) ]] && (( BASH_REMATCH[1] < minimum_sdk )); then
  echo "[apple-stt] the macOS $sdk_version SDK has no SpeechAnalyzer; this helper needs the macOS $minimum_sdk SDK (Xcode or Command Line Tools 26). Without it Snaglet dictates with its local speech-to-text." >&2
  exit 1
fi
mkdir -p "$here/bin"
opt="-O"
[[ "${SNAGLET_STT_DEBUG:-}" == "1" ]] && opt="-Onone -g"
deployment_target="${MACOSX_DEPLOYMENT_TARGET:-14.0}"
target="$(uname -m)-apple-macos${deployment_target}"

echo "[apple-stt] compiling stt.swift → bin/snaglet-apple-stt ($opt, target $target)" >&2
# shellcheck disable=SC2086
swiftc $opt -sdk "$sdk" -target "$target" -framework Speech -framework AVFoundation -o "$out" "$here/stt.swift"
echo "[apple-stt] built $out" >&2
