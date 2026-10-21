#!/usr/bin/env bash
# Screenshot a page with headless Chrome.
#
#   scripts/shot.sh <out.png> [WIDTHxHEIGHT] [page.html] [test.js]
#
# Headless Chrome runs on virtual time and barely advances requestAnimationFrame, so the
# page is rendered from a temporary copy that drives rAF with setTimeout. The screenshot
# is taken when the virtual-time budget ends, not when your test finishes, so set
# `window.__freeze = true` at the moment you want to capture.
#
# An optional test.js runs after src/main.js. Example:
#
#   const ev = (type, x, y) => dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerType: 'mouse' }));
#   setTimeout(() => { ev('pointerdown', 500, 400); /* ... */ window.__freeze = true; }, 1500);
set -euo pipefail

out=${1:?usage: scripts/shot.sh <out.png> [WIDTHxHEIGHT] [page.html] [test.js]}
size=${2:-1100x850}
root=$(cd "$(dirname "$0")/.." && pwd)
page=${3:-$root/index.html}
test=${4:-}
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

tmp="$(dirname "$page")/.shot.html"
trap 'rm -f "$tmp"' EXIT
raf='<script>window.requestAnimationFrame = f => setTimeout(() => window.__freeze || f(performance.now()), 16);</script>'
extra=''
[ -n "$test" ] && extra="<script>$(cat "$test")</script>"
# Inject the rAF shim before main.js and the optional test after it.
python3 - "$page" "$tmp" "$raf" "$extra" <<'EOF'
import sys
page, tmp, raf, extra = sys.argv[1:]
s = open(page).read()
tag = '<script src="src/main.js"></script>'
open(tmp, 'w').write(s.replace(tag, raf + tag + extra))
EOF

"$chrome" --headless=new --hide-scrollbars --window-size="${size/x/,}" \
  --virtual-time-budget=10000 --screenshot="$out" "file://$tmp" >/dev/null 2>&1
echo "$out"
