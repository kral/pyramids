#!/bin/bash
# usage: shard.sh <dir> <label> <runs> [args]  -> two shard processes in parallel
dir=$1; label=$2; runs=$3; shift 3; cd $dir
for r in $(seq 1 $runs); do
  load=$(cut -d' ' -f1 /proc/loadavg); s=$(date +%s.%N)
  npx vitest run "$@" --shard 1/2 > /home/claude/perf-lab/logs/$(basename $dir)-$label-$r-a.log 2>&1 &
  npx vitest run "$@" --shard 2/2 > /home/claude/perf-lab/logs/$(basename $dir)-$label-$r-b.log 2>&1 &
  wait; e=$(date +%s.%N); w=$(echo "$e-$s"|bc)
  t=$(grep -hE '^\s+Tests ' /home/claude/perf-lab/logs/$(basename $dir)-$label-$r-?.log | tr -s ' ' | tr '\n' ';')
  printf "%s\t%s\t%s\t%s\t-\t%s\t-\t%s\t%s\n" "$(basename $dir)" "$label" "$r" "$w" "$load" "$t" "$*" >> /home/claude/perf-lab/results.tsv
  echo "$label#$r wall=$w $t"
done
