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
echo "Built $OUTPUT and $PNG_OUTPUT"
