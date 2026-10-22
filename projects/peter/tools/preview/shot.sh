#!/bin/bash
# Screenshot the preview with headless Chrome, killed after 40 s (macOS has no timeout).
# Usage: shot.sh <out.png> "<query, e.g. ?displayId=default&opensettings=1>" [WxH]
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size="${3:-1300,1250}" --virtual-time-budget=8000 \
  --screenshot="$1" "http://localhost:${PORT:-8198}/colony/peter/$2" >/dev/null 2>&1 &
p=$!; for i in $(seq 40); do sleep 1; kill -0 $p 2>/dev/null || exit 0; done; kill $p
