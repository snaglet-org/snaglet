#!/usr/bin/env bash
# Build the Snaglet NLP entity-extraction helper. macOS-only (needs swiftc + the
# NaturalLanguage framework, which ships with the OS — no special SDK needed).
# Emits a single self-contained binary to bin/snaglet-nlp-helper (gitignored).
#
#   ./build.sh            # release build (-O)
#   SNAGLET_NLP_DEBUG=1 ./build.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="$here/bin/snaglet-nlp-helper"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "[nlp-helper] not macOS — skipping build (search falls back to raw-content FTS)" >&2
  exit 0
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "[nlp-helper] swiftc not found — install Xcode command line tools to build" >&2
  exit 1
fi

source "$here/../macos-sdk.sh"
sdk="$(snaglet_macos_sdk)"
mkdir -p "$here/bin"
opt="-O"
[[ "${SNAGLET_NLP_DEBUG:-}" == "1" ]] && opt="-Onone -g"
deployment_target="${MACOSX_DEPLOYMENT_TARGET:-14.0}"
target="$(uname -m)-apple-macos${deployment_target}"

echo "[nlp-helper] compiling nlp.swift → bin/snaglet-nlp-helper ($opt, target $target)" >&2
# shellcheck disable=SC2086
swiftc $opt -sdk "$sdk" -target "$target" -framework NaturalLanguage -o "$out" "$here/nlp.swift"
echo "[nlp-helper] built $out" >&2
