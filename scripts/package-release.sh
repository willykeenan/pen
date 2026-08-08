#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/Pen.app"

if [[ ! -d "$APP" ]]; then
  echo "Build dist/Pen.app before packaging." >&2
  exit 1
fi

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
ARCH="$(file "$APP/Contents/MacOS/KEPenApp")"
if [[ "$ARCH" != *"arm64"* ]]; then
  echo "The public release must contain the verified Apple Silicon executable." >&2
  exit 1
fi

PACKAGE_WORK="$(mktemp -d)"
trap 'rm -rf "$PACKAGE_WORK"' EXIT
STAGE="$PACKAGE_WORK/KE Pen"
DMG="$ROOT/dist/KE-Pen-${VERSION}-arm64.dmg"
CHECKSUM="$DMG.sha256"

mkdir -p "$STAGE"
ditto "$APP" "$STAGE/Pen.app"
ln -s /Applications "$STAGE/Applications"
cp "$ROOT/README.md" "$STAGE/README.md"
cp "$ROOT/LICENSE" "$STAGE/LICENSE"
cp "$ROOT/PRIVACY.md" "$STAGE/PRIVACY.md"
cp "$ROOT/SECURITY.md" "$STAGE/SECURITY.md"

codesign --verify --deep --strict --verbose=2 "$STAGE/Pen.app"
rm -f "$DMG" "$CHECKSUM"
hdiutil create -volname "KE Pen ${VERSION}" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null

HASH="$(openssl dgst -sha256 "$DMG" | awk '{print $2}')"
printf '%s  %s\n' "$HASH" "$(basename "$DMG")" > "$CHECKSUM"

echo "Built $DMG"
echo "SHA-256 $HASH"
echo "Free release boundary: ad-hoc signed, not Developer ID signed or notarized."
