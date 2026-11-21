#!/usr/bin/env bash
# Regenerate the README text captures: the real CLI runs in a pseudo-terminal (scripts/pty-run.py)
# and the screen is reconstructed by a VT emulator (pyte, `pip install pyte`), ANSI stripped.
# Output: docs/captures/*.txt
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build >/dev/null
mkdir -p docs/captures
export TERM=xterm-256color COLORTERM=truecolor LANG=C.UTF-8 VTO_LANG="${VTO_LANG:-en}"
CLI=(node bin/vto-ui.mjs --mock)
cap() { # name cols rows steps -- extra args
  local name=$1 cols=$2 rows=$3 steps=$4; shift 4
  python3 scripts/pty-run.py "$cols" "$rows" "$steps" -- "${CLI[@]}" "$@" > "/tmp/vto-cap-$name.raw" 2> "/tmp/vto-cap-$name.err" || true
  local at; at=$(grep -o 'SNAP [0-9]*' "/tmp/vto-cap-$name.err" | tail -1 | cut -d' ' -f2)
  python3 scripts/screen.py "$cols" "$rows" --at "$at" < "/tmp/vto-cap-$name.raw" | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}' > "docs/captures/$name.txt"
  echo "docs/captures/$name.txt"
}
# 1) run in progress: ~45 % of a 20 s run, failures streaming in, one already fixed
cap progress 120 32 "until:Selhání,wait:4200,key:j,wait:400,snap,key:q" --mock-duration 20000 --mock-speed 2
# 2) details pane zoomed (cart failure: object diff + both code frames)
cap details 100 40 "until:dokončeno,key:j,key:j,key:\r,wait:400,snap,key:q" --mock-speed 8
# 3) fixed during the run: R re-runs every failure, the mock turns them green
cap fixed 120 30 "until:dokončeno,key:R,wait:2500,key:j,wait:300,snap,key:q" --mock-speed 8
# 4) CI / non-TTY output
NO_COLOR=1 node bin/vto-ui.mjs --mock --ci --mock-speed 8 > docs/captures/ci.txt || true
echo docs/captures/ci.txt
