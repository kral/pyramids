#!/bin/bash
# confirmation reruns, interleaved (A B C D E F, A B C D E F) to spread machine-load drift
B=/home/claude/perf-lab/scripts/bench.sh; H=/home/claude/perf-lab/heavy; F=.1.test
for round in 1 2; do
  $B $H baseline 1 $F
  $B $H happydom 1 $F --environment happy-dom
  $B $H vmThreads 1 $F --pool vmThreads
  $B $H noisolate 1 $F --no-isolate
  $B $H css 1 $F --config vitest.css.config.ts
  $B $H optimizer 1 $F --config vitest.optimizer.config.ts
  $B $H deep-plugin 1 $F --config vitest.deep.config.ts
done
echo BATCH3 DONE
