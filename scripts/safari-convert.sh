#!/usr/bin/env bash
# Turns the Safari extension folder into an Xcode project (macOS with Xcode only).
#   scripts/safari-convert.sh [--no-open]
# Then in Xcode: pick the "LFC Tools" scheme, press Run, and enable the extension in
# Safari > Settings > Extensions (Safari > Develop > Allow Unsigned Extensions for builds
# that are not signed).
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/build-safari.mjs
xcrun safari-web-extension-converter dist/safari-extension \
  --app-name "LFC Tools" \
  --bundle-identifier com.lfcrea.lfctools \
  --project-location dist/safari-xcode \
  --macos-only --swift --copy-resources --no-prompt --force "$@"
