#!/usr/bin/env bash
# Build the Snaglet Apple Chat sidecar. macOS-only (needs swiftc; the SDK compiles
# even without FoundationModels present — see chat.swift's stub path — but
# only macOS 26+ with Apple Intelligence enabled actually generates).
# Emits a single self-contained binary to bin/snaglet-apple-chat (gitignored).
#
#   ./build.sh            # release build (-O)
#   SNAGLET_CHAT_DEBUG=1 ./build.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="$here/bin/snaglet-apple-chat"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "[apple-chat] not macOS — skipping build (provider stays hidden)" >&2
  exit 0
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "[apple-chat] swiftc not found — install Xcode command line tools to build" >&2
  exit 1
fi

source "$here/../macos-sdk.sh"
sdk="$(snaglet_macos_sdk)"
mkdir -p "$here/bin"
opt="-O"
[[ "${SNAGLET_CHAT_DEBUG:-}" == "1" ]] && opt="-Onone -g"
deployment_target="${MACOSX_DEPLOYMENT_TARGET:-14.0}"
target="$(uname -m)-apple-macos${deployment_target}"

echo "[apple-chat] compiling chat.swift → bin/snaglet-apple-chat ($opt, target $target)" >&2
# No `-framework FoundationModels`: on a pre-26 SDK that flag fails to link,
# while `import` auto-links the framework when it is present, and chat.swift's
# `#if canImport(FoundationModels)` guard covers its absence.
# shellcheck disable=SC2086
swiftc $opt -sdk "$sdk" -target "$target" -o "$out" "$here/chat.swift"
echo "[apple-chat] built $out" >&2
