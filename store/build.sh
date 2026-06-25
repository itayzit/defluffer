#!/usr/bin/env bash
# Build the upload-ready extension zip — only the files Chrome needs.
# Excludes the Worker, demo assets, store docs, media, and the API key.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p dist
rm -f dist/defluff.zip
zip -q dist/defluff.zip \
  manifest.json \
  content.js \
  background.js \
  popup.html \
  popup.js \
  styles.css \
  icons/icon16.png \
  icons/icon48.png \
  icons/icon128.png

echo "Built dist/defluff.zip:"
unzip -l dist/defluff.zip
