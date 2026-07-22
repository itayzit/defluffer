#!/usr/bin/env bash
# Build the Firefox (AMO) zip. Same code as Chrome; only the manifest differs:
# Firefox ships MV2 so host permissions are granted at install (Firefox MV3
# makes them opt-in, which would leave new users with a silently dead extension).
# Keep store/manifest-firefox.json's version in sync with manifest.json.
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME_V=$(node -e "console.log(require('./manifest.json').version)")
FIREFOX_V=$(node -e "console.log(require('./store/manifest-firefox.json').version)")
if [ "$CHROME_V" != "$FIREFOX_V" ]; then
  echo "version mismatch: manifest.json=$CHROME_V manifest-firefox.json=$FIREFOX_V" >&2
  exit 1
fi

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/icons" dist
cp content.js background.js popup.html popup.js styles.css "$STAGE/"
cp icons/icon16.png icons/icon48.png icons/icon128.png "$STAGE/icons/"
cp store/manifest-firefox.json "$STAGE/manifest.json"

rm -f dist/defluff-firefox.zip
(cd "$STAGE" && zip -qr - .) > dist/defluff-firefox.zip

echo "Built dist/defluff-firefox.zip (v$FIREFOX_V):"
unzip -l dist/defluff-firefox.zip
