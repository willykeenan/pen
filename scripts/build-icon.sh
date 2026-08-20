#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/assets/pen-icon.svg"
OUTPUT="$ROOT/assets/Pen.icns"
PNG_OUTPUT="$ROOT/assets/pen-icon.png"

ICON_WORK="$(mktemp -d)"
trap 'rm -rf "$ICON_WORK"' EXIT
ICONSET="$ICON_WORK/Pen.iconset"
PREVIEW="$ICON_WORK/preview"
mkdir -p "$ICONSET" "$PREVIEW"

qlmanage -t -s 1024 -o "$PREVIEW" "$SOURCE" >/dev/null
BASE="$PREVIEW/$(basename "$SOURCE").png"
if [[ ! -f "$BASE" ]]; then
  echo "Quick Look did not render the icon source." >&2
  exit 1
fi

cp "$BASE" "$PNG_OUTPUT"

render_icon() {
  local size="$1"
  local name="$2"
  sips -z "$size" "$size" "$BASE" --out "$ICONSET/$name" >/dev/null
}

render_icon 16 icon_16x16.png
render_icon 32 icon_16x16@2x.png
render_icon 32 icon_32x32.png
render_icon 64 icon_32x32@2x.png
render_icon 128 icon_128x128.png
render_icon 256 icon_128x128@2x.png
render_icon 256 icon_256x256.png
render_icon 512 icon_256x256@2x.png
render_icon 512 icon_512x512.png
render_icon 1024 icon_512x512@2x.png

iconutil -c icns "$ICONSET" -o "$OUTPUT"

# Menu-bar template glyph: monochrome camera at 18pt + @2x. The "Template"
# filename suffix is what makes Electron treat it as a macOS template image.
TRAY_SOURCE="$ROOT/assets/tray-icon.svg"
qlmanage -t -s 1024 -o "$PREVIEW" "$TRAY_SOURCE" >/dev/null
TRAY_BASE="$PREVIEW/$(basename "$TRAY_SOURCE").png"
if [[ ! -f "$TRAY_BASE" ]]; then
  echo "Quick Look did not render the tray icon source." >&2
  exit 1
fi
sips -z 18 18 "$TRAY_BASE" --out "$ROOT/assets/trayTemplate.png" >/dev/null
sips -z 36 36 "$TRAY_BASE" --out "$ROOT/assets/trayTemplate@2x.png" >/dev/null

echo "Built $OUTPUT, $PNG_OUTPUT, and the tray template glyphs"
