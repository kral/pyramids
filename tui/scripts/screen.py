#!/usr/bin/env python3
"""Replay raw terminal output through a VT emulator (pyte) and print the visible screen as text.
usage: screen.py COLS ROWS [--at BYTES] < raw   (--at: stop after N bytes, to see an earlier frame)
Dev tool for README captures and for checking what a real terminal would show."""
import sys
import pyte

cols, rows = int(sys.argv[1]), int(sys.argv[2])
raw = sys.stdin.buffer.read()
if '--at' in sys.argv:
    raw = raw[: int(sys.argv[sys.argv.index('--at') + 1])]
data = raw.decode('utf-8', 'replace')
screen = pyte.Screen(cols, rows)
stream = pyte.Stream(screen)
stream.feed(data)
for line in screen.display:
    print(line.rstrip())
