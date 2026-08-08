#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/Pen.app"
CONTENTS="$APP/Contents"

cd "$ROOT"
swift build -c release --product KEPenApp

if [[ -e "$APP" ]]; then
  rm -rf "$APP"
fi

mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources/mcp"
cp "$ROOT/.build/release/KEPenApp" "$CONTENTS/MacOS/KEPenApp"
cp "$ROOT/scripts/Info.plist" "$CONTENTS/Info.plist"
cp "$ROOT/assets/Pen.icns" "$CONTENTS/Resources/Pen.icns"
cp "$ROOT/dist/mcp-app/index.js" "$CONTENTS/Resources/mcp/index.js"
chmod 755 "$CONTENTS/Resources/mcp/index.js"

codesign --force --deep --sign - "$APP" >/dev/null
echo "Built $APP"
