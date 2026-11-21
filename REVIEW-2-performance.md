# REVIEW-2: performance and scalability (independent)

Date 2026-11-21. Code under test: commit **`e6598d9`**. The code paths I measured (`mcp/`, `collector/`,
`vitest-guard/src`, `verify/`, `tui/src`, `analyzer/src`) are byte-identical in `2c2def1`. Every measurement
finished before the parallel fix agents started editing the working tree (first edit to a measured file at
08:50:57 UTC; my last kept run, verify-subset, ended at 08:49). The analyzer was built from `git archive HEAD`
into `/home/claude/review2-perf/target`. vitest-guard for the real-world suite runs was a copy of HEAD placed in the
lab copy. Nothing in the product was modified. `/path/to/real-suite` was not touched.

All scripts, raw logs and profiles are in `/home/claude/review2-perf/` (`scripts/`, `logs/`, `prof/`).

## Methodology

- Machine: 2 cores shared with other reviewers, Node 22.23, Vitest 5.1.1. Load average was 1–6 during the runs.
- **CPU = user+sys of the whole waited-for process tree** (`scripts/meas.py`, `wait4`/`RUSAGE_CHILDREN`).
  For the daemon I used `/proc` tree CPU of the daemon, its lanes and workers (`mcp/dev/proc-cpu.mjs`), plus
  the daemon process alone. Wall time is secondary.
- Results are medians with (min–max). Plain and instrumented runs were interleaved A-B-A-B-A-B (n=3) and are
  reported as paired ratios. Analyzer runs used n=3.
- Synthetic suites:
  - the analyzer `gen` binary, at 3k / 10k / 30k tests × 1k / 3k source modules (400 blocks each, i.e. 0.4M / 1.2M
    blocks), in `sparse` (default) and `--dense` (app-shell) shapes;
  - an adversarial "app shell" generator (`scripts/gen-shell.py`).
  - Real suites: a copy of `bench-project` (312 files / 3195 tests, React + RTL + jsdom) and a copy of the
    the real-world suite lab (1992 tests, projects `dom` + `node`).
- Daemon map scaling uses the **real `MapStore` code** fed with gen data (`scripts/store-bench.mjs`). Live
  coverage uses the **real `Engine.prototype.coverageEvent`** (`scripts/cov-bench.mjs`). MCP timings use the
  real `vto-mcp` over stdio (`scripts/mcp-time.mjs`).
- Profiling:
  - The daemon was profiled with an in-process inspector wrapper (`scripts/prof-wrap.mjs`). `node --cpu-prof`
    cannot be used on the daemon (see finding P6).
  - The analyzer phases come from `--timings`.

## Summary table

| area | scale | result | verdict |
|---|---|---|---|
| analyzer `report` | 30k tests × 3k modules | 4.0 s CPU, 727 MB RSS | linear except set cover (~n^1.7). **Fixed in a prototype: −36…−40 % CPU, identical output** |
| analyzer `report`, adversarial app shell | 30k tests × 320 shared blocks | **23.4 s CPU, 2.47 GB RSS** (3k: 0.27 s / 40 MB) | **quadratic** in time and memory (P1) |
| analyzer `affected` | 30k × 3k | 1.1 s CPU raw, 0.6 s on a packed map | ok, but paid on every daemon selection (P4) |
| collector overhead, bench-project, vmThreads | 3195 tests | **+12.4 %** CPU (10.9–13.7), raw 0.88 MB (277 B/test) | claim "~3 % / not measurable" not supported for vm pools |
| collector overhead, the real-world suite `node` project | 1120 tests | **+5.8 %** CPU (4.1–7.1) | consistent with the claimed +5.2 % |
| daemon `run_affected`, 1 component edit, vm | bench-project | **1.92 s wall / 1.76 s tree CPU** median over 100 runs (p90 3.3 s / 1.87 s) | claim "~2 s" **confirmed** |
| daemon, 200 incremental runs | bench-project | heap 11–30 MB with no trend; fds 24–25 constant; 1 lane process constant; RSS 65 → 127 MB | no JS/fd/child leak; slow RSS growth (P8) |
| daemon map patch, 100 incremental runs | 30k × 3k | ingest+save ~90–100 ms CPU/run, heap flat at 194 MB; cold load 1.2–2.0 s | ok |
| live coverage events | 10k / 30k tests | **10 ms / 32 ms per event** on the daemon main thread; 6k events = 198 s for a 30k full run | **O(tests hitting the file) per event** (P2) |
| MCP tools | 3k / 10k / 30k | all scoped tools < 30 ms warm; `test_overlap` first call after any run 0.1 / 0.9 / **3.8 s**; `affected_tests` after an edit at 30k: 0.8 s (1.75 s cold) | ok up to 10k (P3, P4) |
| TUI with mock | 10k / 30k events | 5.3k / 16k ev/s, render p50 7 / 8 ms, p95 11 / 11–16 ms, loop lag p99 19–23 / 20–30 ms, heap Δ 14–24 / 40–55 MB | fine, linear |
| `.vto/` growth | 200 runs | runs/ capped (30 files); blobs +1 per edited version, **never collected**; metrics.jsonl +0.42 KB/run, daemon.log +0.14 KB/run, lane logs unbounded (**32 MB in 70 runs** in an error loop) | P5 |
| vitest-guard auto calibrated, the real-world suite | 1992 tests | **−30.5 %** (−27…−35) vs current, plus 78 s CPU one-time calibrate; 0 failures in all 6 runs | claim −34 % is at the optimistic end |
| verify (schemata) | 16 ordered pairs, `--max-mutants 30` | 358 test×mutant runs in 6.5 s CPU (≈18 ms/run) | all 38 212 candidates: >600 s, run killed (P9) |

## Findings by severity

### High

**P1: analyzer strict-subset search is quadratic in time and memory on app-shell suites** (`analyzer/src/analysis.rs`, step 4)

- **Data set.** 30k tests, each hitting a random 250–320 of 320 shared blocks (every test renders `<App/>`).
- **Scaling.**

  | tests | subsumed phase | CPU | RSS |
  |---|---|---|---|
  | 3k | 96 ms | 0.27 s | 40 MB |
  | 10k | 1.3 s | 2.7 s | 307 MB |
  | 30k | 11.9 s | 23.4 s | **2.47 GB** |

  Even with all sizes equal (0 results) the 30k case takes 13.6 s and 2.9 GB.
- **Memory cause (verified).** `cand.into_iter().filter(..).collect()` uses Rust's in-place collect, so every
  per-rep `out` Vec keeps the capacity of its ~21k-entry candidate list. With `.iter().copied()` instead, RSS
  drops **2.47 GB → 184 MB** and the output is byte-identical (prototype in `/home/claude/review2-perf/analyzer-patched`).
- **Time cause.** If more than 32 candidates are left after 4 posting intersections, every one of them gets a
  bitset check, so the cost is O(n²) when the rarest items are shared.
- **Fix.**
  - Check `rsize[b] > rsize[a]` before the bitset check.
  - Number reps by size, so that each posting list can be binary-searched to the larger reps.
  - Add a candidate budget like near-duplicates have (`max_near_candidates`): stop after `max_supersets` hits and
    report `byCount` as "≥ k" when truncated.
- **Expected gain.** Bounded run time (≈0.2 s at 30k).

**P2: live coverage events cost O(all tests hitting the file) per event on the daemon main thread** (`engine.mjs` `liveHits`, `coverage.mjs` `computeCoverage`)

- **Cost.** 10 ms per event at 10k tests and 32 ms per event at 30k tests, roughly constant over the run.
  Replaying a 30k full run (6k events, no throttle) costs 198 s of CPU and produces 225 MB of events
  (3k README measurement: 2.4 MB).
- **Throttled.** With the 300 ms throttle, one hot module (theme, utils, i18n) still costs ≈100 ms of CPU per
  second, which blocks IPC and MCP replies for 30 ms at a time while a TUI or VS Code client subscribes to
  `coverage`.
- **Profile.**
  - `computeCoverage` 54 %: it rebuilds `byBlock` key arrays and the `testsByLine` sets for every test.
  - `liveHits` 39 %, of which `absOf` → `path.resolve` per key is 24 %: `new Map(base)` plus
    `k.split(':')` / `absOf` for every hit, on every event.
- **Fix.** Keep incremental per-file aggregates per run:
  - per-block hit counts;
  - per-block key lists, with a test-file → keys index so a finished test file is removed once;
  - and apply only the overlay delta since the last event.
- **Expected gain.** Per-event cost becomes O(tests changed since the last emit): ≥ 50× at 30k, and the
  main thread stays responsive.

### Medium

**P3: every map change invalidates the full analyzer report, and the next analysis tool pays for a full run** (`analysis.mjs` `getReport`)

- `test_overlap` / `slow_tests` / `slow_imports{file}` re-run the full `vto` report after every run, because
  `generation` bumps.
- Cost: 105 ms at 3k, 863 ms at 10k, 3.76 s at 30k × 3k. After that, answers take 2–12 ms from the cache.
- Options:
  - Regenerate in the background after `run-end` when no run is queued.
  - Or invalidate only when the changed tests intersect the scope.
  - The set-cover fix (P7) and the P1 fix also cut this time by ~40 %.

**P4: every selection spawns the analyzer over the whole map** (`select.mjs` → `analyzer.affected`)

- `affected_tests` after a one-line edit takes 0.8 s warm / 1.75 s cold at 30k × 3k, and 4–13 ms at 3k.
- The map is re-parsed from 48 MB of JSONL every time, although the daemon already holds it in memory
  (`MapStore`, 194–384 MB heap at 30k).
- Options:
  - Select in JS from the in-memory hits for the common case (one or a few changed files): a block-overlap
    lookup over `tests hitting f`.
  - Or keep a resident analyzer process fed with a `vto pack` map: 0.6 s vs 1.1 s on raw.
- Expected: `affected_tests` < 50 ms at 30k.

**P5: `.vto/` and log growth without retention** (`store.mjs`, `metrics.mjs`, `lane-client.mjs`, `daemon.mjs`)

- `runs/` is pruned to 30 files (`pruneRuns`). Good.
- `blobs/` gets one file per recorded version of every edited file (+1 per run in the soak). `gc()` drops state
  entries but **never deletes blob files**. Fix: delete blobs that no `state.files[*].sha`/`prevSha` references.
- `metrics.jsonl` is append-only (+0.42 KB/run) and is read and parsed whole on every `savings_report`.
  Fix: rotate by age (keep 90 days) or keep daily aggregates.
- `daemon.log` gets one line per request (+0.14 KB/run).
- `lane-*.log` is opened with `'a'` and never rotated. In the P6 failure loop it grew to **32 MB in 70 runs**.
  Fix: size-capped rotation (e.g. 5 MB × 2).

**P6: a lane whose workers cannot start reports a green run** (`engine.mjs` run finalisation)

- **Trigger.** Starting the daemon with `node --cpu-prof` breaks every vmThreads worker, because `fork()`
  inherits `execArgv` and worker threads reject `--cpu-prof`. The same happens with `NODE_OPTIONS=--cpu-prof`.
- **What the run reports.** `ran 0, failed 0, runAll true` every time, so `wait_run` looks green. The worker
  errors only appear as "(unhandled)" failure events and in the lane log.
- **Fix, two parts.**
  - A run that executed 0 of N > 0 planned tests should be `status: error`.
  - Strip `--cpu-prof*` / `--inspect*` from the lanes' `execArgv`, or document `VTO_PROFILE` via
    `inspector.Session`, as in `scripts/prof-wrap.mjs`.

**P7: set-cover greedy is superlinear** (`analysis.rs` step 6)

- Each `gain()` call scans the rep's bitset over its word span. Tests that hit the util module plus scattered
  clusters span the whole item space (≈10k words at 655k items).
- Measured setcover time: 16 → 246 → 926 ms for 3k → 10k → 30k tests (1k modules), and 2.16 s at 30k × 3k.
- **Prototype (verified identical `report.json`).** Computing the gain over the sorted rank list instead
  (`rem` indexed by rank):

  | data set | setcover before → after | total CPU before → after |
  |---|---|---|
  | 30k × 1k | 963 → 69 ms | 2.50 → 1.50 s (**−40 %**) |
  | 30k × 3k | 1480 → 60 ms | 3.88 → 2.46 s (**−36 %**) |

**P8: daemon RSS creeps under load**

- Over 100 unprofiled incremental runs, RSS went 65 → 127 MB (≈0.5 MB/run after warm-up). The JS heap stayed
  at 11–30 MB with no trend, fds stayed at 24–25, and the lane stayed one process (201–318 MB, stable).
- So there is no JS heap leak, fd leak or child-process leak in 200 runs.
- The RSS growth is likely retained buffers or allocator behaviour: per-run `snapshot` texts, and 20 runs kept
  in `this.runs` with their `live` maps.
- Recommended:
  - Drop `run.snapshot` and `run.live` at run end.
  - Do a longer soak (1000 runs) with heap snapshots before 1.0.

### Low / info

- **P9 verify cost.**
  - The schemata strategy costs ≈18 ms per test×mutant run (358 runs: 6.5 s CPU).
  - Running verify over all 38 212 report candidates of bench-project (`--max-mutants 30`) did not finish in
    600 s and was killed.
  - So `verify` needs `--only-pairs`/tiers in practice. The README should say that a whole-report verify is not
    a supported use, and give the cost formula (Σ tests × planned mutants × test time).
- **Analyzer memory at scale.** 727 MB RSS for 30k × 3k (report), 449 MB for `affected`. Raw parse dominates
  (load+parse 2.1 s of 6.4 s wall). The gen raw holds one `file` record per worker (104 MB). Real collector raw
  is small: bench-project 277 B/test.
- **Map patching is fine.**
  - At 30k × 3k: first ingest 3.4–3.7 s CPU; incremental ingest + save ≈90–100 ms CPU; `changedFiles`
    15–30 ms warm; heap flat over 100 edits.
  - Daemon main-thread busy time on bench-project is ≈40 ms per incremental run. 13 ms of that is `save()`
    (11 atomic renames), 6 ms is the analyzer spawn and 4 ms is ingest.
  - Small wins:
    - skip `state.json` rewrite when unchanged;
    - batch shard writes.
- **Hidden quadratic paths in the store (not hit in my runs, but the same O(T)-per-file shape as P2).**
  - `loadersOf(f)` and `gc()` scan all test records once per untracked or changed file.
  - The `Object.keys(dirtyTests)` × `startsWith` loop runs once per fully replaced test file
    (`ingest` step 2, `removeTestFile`). On a full run with many dirty tests this is O(files × dirty).
  - Fix: keep a `file → keys` index.

## Verification of headline claims

| claim (where) | my measurement | verdict |
|---|---|---|
| `run_affected` ~2 s after a component edit, bench-project, vm (mcp/README) | 1.92 s wall / 1.76 s tree CPU median, n=100 (unprofiled); 2.02 / 1.93 s, n=100 (profiled); 80 tests, 0 run-all | **confirmed** |
| collector +5.2 % CPU on the real-world suite node project (commit `e6598d9` message only, no data in the repo) | +5.8 % (4.1–7.1), n=3 paired | **consistent**; put the data in the repo |
| collector overhead "not measurable" (mcp/README: 305 vs 308.5 s, forks, n=1, raw data in `/tmp/vto-work`) / "~3 %" | bench-project **vmThreads: +12.4 % (10.9–13.7)**, n=3 paired | **not supported for vm pools**: the forks denominator hides it. State the overhead per pool. |
| vitest-guard auto calibrated −34 % vs current on the real-world suite (vitest-guard/README; data only in `/home/claude/vmguard-lab/auto-bench.tsv`, outside the repo) | current 175.9 (172.0–176.0) s, auto calibrated 122.2 (115.0–125.1) s → **−30.5 %**; calibrate 77.9 s one-time; 1992/1992 pass in all 6 runs | **partially**: real but ~4 pp lower; say "−30…−35 %", include the calibrate cost |
| heavy −96 % vs forks (vitest-guard/README) | not re-run (forks ≈ 480 s CPU per run did not fit the budget) | **not verified**; the evidence is outside the repo |
| analyzer ≤ 1 s and ≤ 300 MB at 10k tests (ARCHITECTURE §1.2) | 10k × 1k modules: 0.94 s, 200 MB; **10k × 3k modules: 1.92 s, 343 MB**; adversarial 10k: 2.7 s, 307 MB | **met only for small source trees** |
| TUI 10k: render p50 8–12 ms, loop lag p99 40–100 ms (tui/README) | p50 7.1 ms, p95 10–11 ms, lag p99 19–23 ms (load ~2) | consistent |
| coverage events cost nothing (mcp/README, 3k) | true at 3k. 30k: 32 ms per event on the main thread | **does not scale** (P2) |
| vitest-guard layer overhead +2–4 % (README, ARCHITECTURE "met") | not re-measured. the real-world suite validation already found dom +5.9 % | the README should cite the range |

**Claims without measurement data in the repo:**
- every mcp/README table (raw data in `/tmp/vto-work`);
- vitest-guard auto and heavy numbers (`vmguard-lab`);
- the commit-message +5.2 %.

Recommendation: commit a `perf/data/` with the TSV/JSON behind each README number.

## Recommended optimizations (expected gain)

1. Analyzer P1. Non-consuming iteration plus size pre-filter plus candidate budget. **−92 % RSS measured**
   (2.47 GB → 184 MB) and bounded time on app-shell suites.
2. Analyzer P7. Sparse set-cover gain. **−36…−40 % report CPU at 30k measured**, identical output.
3. Daemon P2. Incremental live-coverage aggregates. ≥ 50× less main-thread CPU per event at 30k, no IPC stalls.
4. Daemon P4. In-memory JS selection for small diffs (or a resident analyzer with a packed map).
   `affected_tests` 0.8 s → < 50 ms at 30k.
5. Daemon P3. Background report regeneration after `run-end`. Removes the 0.9–3.8 s first-query stall at
   10k–30k.
6. Retention P5. Blob GC, metrics rotation, lane-log rotation. Bounded `.vto/`.
7. Collector. The vm-pool overhead (+12 %) comes from per-test marker execution in hot code. the real-world suite
   validation already ruled out source maps and transform. Options:
   - mark loop bodies once per test;
   - skip markers inside functions hit in every test (shell blocks, learned from the previous map);
   - measure in vm pools.

   Target ≤ 5 % in every pool.
8. P6. Fail runs that executed 0 of N tests. Strip profiler flags from the lanes' `execArgv`.

## Reproduction

```sh
cd /home/claude/review2-perf
scripts/an-matrix.sh                                      # analyzer matrix → logs/analyzer.jsonl
python3 scripts/gen-shell.py 30000 320 250 syn/shellv-n30000 0   # (VARK=1) adversarial subsets
node scripts/soak.mjs $PWD/bp 100 logs/soak2.jsonl --offset 1000  # daemon soak (vm), add --prof DIR for profiles
node --expose-gc scripts/store-bench.mjs syn/n30000-m3000-sparse $PWD/sr 100 logs/store.jsonl
node scripts/cov-bench.mjs $PWD/sm-n30000-m3000-sparse 1500
node scripts/mcp-time.mjs $PWD/sm-n30000-m3000-sparse logs/mcp.jsonl x --no-daemon --reps 3
scripts/long.sh                                           # collector overhead + vitest-guard auto (≈ 25 min)
```
