#!/bin/bash
# usage: bench.sh <projectdir> <label> <runs> [vitest args...]
dir=$1; label=$2; runs=$3; shift 3
out=/home/claude/perf-lab/results.tsv; logd=/home/claude/perf-lab/logs; mkdir -p $logd
cd $dir
for r in $(seq 1 $runs); do
  log=$logd/$(basename $dir)-$label-$r.log
  load=$(cut -d' ' -f1 /proc/loadavg)
  TIMEFORMAT='%R %U %S'
  { time npx vitest run "$@" > $log 2>&1 ; } 2> /tmp/t.$$
  read wall usr sys < /tmp/t.$$
  dur=$(grep -E '^\s+Duration' $log | sed 's/^\s*Duration\s*//')
  tests=$(grep -E '^\s+Tests ' $log | sed 's/^\s*Tests\s*//')
  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$(basename $dir)" "$label" "$r" "$wall" "$(echo "$usr+$sys"|bc)" "$load" "$dur" "$tests" "$*" >> $out
  echo "$label#$r wall=$wall cpu=$(echo "$usr+$sys"|bc) load=$load | $dur | $tests"
done
