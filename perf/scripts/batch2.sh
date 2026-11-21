#!/bin/bash
B=/home/claude/perf-lab/scripts/bench.sh; L=/home/claude/perf-lab; F=.1.test
H=$L/heavy; I=$L/heavy-iconbarrel; O=$L/heavy-ownbarrel
# --- imports
$B $H deep-plugin 3 $F --config vitest.deep.config.ts
$B $H stubicons 3 $F --config vitest.stubicons.config.ts
$B $H inline-mui 3 $F --config vitest.inline.config.ts
$B $I baseline 3 $F
$B $I deep-plugin 3 $F --config vitest.deep.config.ts
$B $I stubicons 3 $F --config vitest.stubicons.config.ts
$B $I optimizer 3 $F --config vitest.optimizer2.config.ts
$B $I noisolate 3 $F --no-isolate
$B $O baseline 3 $F
$B $O noisolate 3 $F --no-isolate
$B $H deep-vmThreads 3 $F --config vitest.deep.config.ts --pool vmThreads
# --- happy-dom tuning
$B $H jsdom-defaultHidden 3 $F --config vitest.jsdomhidden.config.ts
$B $H hd-defaultHidden 3 $F --config vitest.hdhidden.config.ts
$B $H hd-settings 3 $F --config vitest.hdsettings.config.ts
$B $H hd-both 3 $F --config vitest.hdboth.config.ts
echo BATCH2 DONE
