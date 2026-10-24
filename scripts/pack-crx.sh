#!/usr/bin/env bash
# Signs the extension into a .crx with the private key that matches the "key" in
# manifest.json (so the extension keeps its id), and writes the update manifest Chrome polls.
#   EXT_KEY_FILE=key.pem CHROME_BIN=google-chrome scripts/pack-crx.sh <crx-url> [out-dir]
# <crx-url> is where the .crx will be downloadable. Output: <out-dir>/lfc-tools-<ver>.crx and
# <out-dir>/updates.xml. The private key is never written into the output.
set -euo pipefail
cd "$(dirname "$0")/.."
url="${1:?usage: pack-crx.sh <crx-url> [out-dir]}"
out="${2:-dist/crx}"
chrome="${CHROME_BIN:-google-chrome}"
key="${EXT_KEY_FILE:?set EXT_KEY_FILE to the private key (.pem)}"

version="$(node -p "require('./manifest.json').version")"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/ext"
node scripts/stage-chrome.mjs "$stage/ext"
cp "$key" "$stage/ext.pem"
"$chrome" --headless=new --no-sandbox --pack-extension="$stage/ext" --pack-extension-key="$stage/ext.pem" >/dev/null 2>&1 || true
[ -f "$stage/ext.crx" ] || { echo "Chrome did not produce a .crx" >&2; exit 1; }

mkdir -p "$out"
cp "$stage/ext.crx" "$out/lfc-tools-$version.crx"
id="$(node scripts/extension-id.mjs)"
node scripts/update-manifest.mjs "$id" "$version" "$url" > "$out/updates.xml"
echo "Packed $out/lfc-tools-$version.crx (id $id)"
