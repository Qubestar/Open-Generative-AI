#!/bin/sh
# Builds the ScreenCaptureKit recorder helper into electron/bin/vidmyo-capture.
# Requires Xcode Command Line Tools (swiftc). Targets macOS 15+ (SCRecordingOutput).
#   --if-stale  skip when the binary is newer than main.swift (used by `npm run electron`)
set -e
cd "$(dirname "$0")"
OUT=../../electron/bin
BIN="$OUT/vidmyo-capture"
[ "$(uname)" = "Darwin" ] || exit 0
if [ "$1" = "--if-stale" ] && [ -x "$BIN" ] && [ "$BIN" -nt main.swift ]; then
  exit 0
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "vidmyo-capture: swiftc not found (install Xcode Command Line Tools); screen recording will be unavailable" >&2
  exit 0
fi
mkdir -p "$OUT"
swiftc -O -target arm64-apple-macos15.0 -o "$BIN" main.swift
codesign --force --sign - "$BIN" >/dev/null 2>&1 || true
echo "built $BIN"
