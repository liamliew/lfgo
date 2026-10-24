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

# The converter names the app after the app name (com.lfcrea.LFC-Tools) but the extension
# after --bundle-identifier (com.lfcrea.lfctools.Extension). Xcode refuses an extension whose
# id is not prefixed by its app's, so make the app's id the prefix.
grep -rl "com.lfcrea.LFC-Tools" dist/safari-xcode 2>/dev/null | while IFS= read -r f; do
  perl -pi -e 's/com\.lfcrea\.LFC-Tools/com.lfcrea.lfctools/g' "$f"
done
echo "Bundle identifiers now:"
grep -rhoE "PRODUCT_BUNDLE_IDENTIFIER = [^;]+" dist/safari-xcode | sort -u
