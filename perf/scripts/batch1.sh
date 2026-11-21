#!/bin/bash
B=/home/claude/perf-lab/scripts/bench.sh; L=/home/claude/perf-lab
F=.1.test
for d in heavy base; do
  P=$L/$d
  $B $P baseline 3 $F
  $B $P mw2 3 $F --maxWorkers 2
  $B $P happydom 3 $F --environment happy-dom
  $B $P threads 3 $F --pool threads
  $B $P vmThreads 3 $F --pool vmThreads
  $B $P vmForks 3 $F --pool vmForks
  $B $P noisolate 3 $F --no-isolate
  $B $P noisolate-threads 3 $F --no-isolate --pool threads
  $B $P optimizer 3 $F --config vitest.optimizer.config.ts
  $B $P comboSafe 3 $F --config vitest.comboSafe.config.ts
  $B $P comboA 3 $F --config vitest.comboA.config.ts
  $B $P comboB 3 $F --config vitest.comboB.config.ts
  if [ $d = heavy ]; then
    $B $P mw3 3 $F --maxWorkers 3
    $B $P nofp 3 $F --no-file-parallelism --maxWorkers 2
    $B $P css 3 $F --config vitest.css.config.ts
    $B $P nosetup-jestdom 3 $F --config vitest.nosetup.config.ts
    $B $P noreactplugin 3 $F --config vitest.noreact.config.ts
    $B $P nofscache 3 $F --no-fsModuleCache
    $L/scripts/shard.sh $P shard2x1w 3 $F --maxWorkers 1
  fi
done
echo BATCH1 DONE
