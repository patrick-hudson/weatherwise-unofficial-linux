#!/usr/bin/env bash
# Downloads the official WeatherWise icons (not committed to the repo — they
# belong to WeatherWise) from the web app and generates
# the Linux icon set used by electron-builder (build/icons/<size>x<size>.png).
set -euo pipefail
cd "$(dirname "$0")/.."
# --if-missing: do nothing when the icons were already generated.
if [[ "${1:-}" == "--if-missing" && -f build/icons/512x512.png && -f assets/icons/tray-alert.png ]]; then exit 0; fi
BASE=https://web.weatherwise.app
mkdir -p assets/icons build/icons
for f in android-chrome-512x512.png android-chrome-192x192.png apple-touch-icon.png \
         favicon-32x32.png favicon-16x16.png safari-pinned-tab.svg; do
  curl -fsSL "$BASE/$f" -o "assets/icons/$f"
done
SRC=assets/icons/android-chrome-512x512.png
# ImageMagick 7 ships `magick`; 6 (Ubuntu CI runners) only `convert`.
MAGICK=$(command -v magick || command -v convert)
for s in 16 24 32 48 64 128 256 512; do
  "$MAGICK" "$SRC" -resize ${s}x${s} "build/icons/${s}x${s}.png"
done
cp "$SRC" assets/icons/icon.png
# Tray icons (22/44 px for HiDPI) and an "alert" variant with a red badge.
"$MAGICK" "$SRC" -resize 64x64 assets/icons/tray.png
"$MAGICK" "$SRC" -resize 64x64 \( -size 64x64 xc:none -fill '#e53935' -stroke white -strokewidth 3 -draw 'circle 48,16 48,2' \) -composite assets/icons/tray-alert.png
echo "icons ready"
