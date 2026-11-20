#!/usr/bin/env bash
# Sourced by the native helper builders after their macOS platform check.
# Prefer the selected developer tools' current SDK symlink: xcrun can instead
# discover a leftover newer SDK whose Swift interfaces the compiler cannot read.
snaglet_macos_sdk() {
  if [[ -n "${SDKROOT:-}" ]]; then
    printf '%s\n' "$SDKROOT"
    return
  fi
  local developer candidate
  developer="$(xcode-select -p)" || return
  for candidate in \
    "$developer/SDKs/MacOSX.sdk" \
    "$developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"; do
    if [[ -d "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  xcrun --sdk macosx --show-sdk-path
}

# The version (e.g. 26.2) of the SDK at $1, or of the one snaglet_macos_sdk picks.
snaglet_macos_sdk_version() {
  local sdk="${1:-}"
  if [[ -z "$sdk" ]]; then
    sdk="$(snaglet_macos_sdk)" || return
  fi
  xcrun --sdk "$sdk" --show-sdk-version
}
