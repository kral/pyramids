#!/bin/bash
# quiet-machine wall-time round (load ~0.5), interleaved
B=/home/claude/perf-lab/scripts/bench.sh; H=/home/claude/perf-lab/heavy; F=.1.test
for round in 1 2 3; do
  $B $H Q-baseline 1 $F
  $B $H Q-mw2 1 $F --maxWorkers 2
  $B $H Q-happydom 1 $F --environment happy-dom
  $B $H Q-optimizer 1 $F --config vitest.optimizer.config.ts
  $B $H Q-deep-plugin 1 $F --config vitest.deep.config.ts
  $B $H Q-vmThreads 1 $F --pool vmThreads
  $B $H Q-vmThreads-mw2 1 $F --pool vmThreads --maxWorkers 2
  $B $H Q-comboA 1 $F --config vitest.comboA.config.ts
done
echo BATCH4 DONE
