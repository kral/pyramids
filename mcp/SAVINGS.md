# Savings measurement (`vto-daemon savings`, MCP `savings_report`, `vto-daemon ci-report`)

Local only: `.vto/metrics.jsonl` is append-only and never leaves the machine (no telemetry).
Every aggregate states how many runs were **measured** and how many **estimated**.

## 1. What is recorded

Per run (`{"t":"run"}`), written by the engine when a run ends (`src/metrics.mjs`):

| field | source | measured? |
|---|---|---|
| `kind`, `pool`, `mode` (daemon / stateless), `instrumented` | engine | – |
| `testsRun`, `suiteTotal`, `filesRun`, `suiteFiles` | reporter events, map | measured |
| `wallMs` | lane: `runTestSpecifications` start → end | measured |
| `cpuMs` | lane `process.cpuUsage()` – includes worker **threads** (`threads`, `vmThreads`), **excludes child processes** (`forks`, `vmForks`) | measured (lower bound for forks) |
| `ttffMs` | run start → first `failure` event | measured |
| `testMsSum` | Σ per-test durations from Vitest | measured |
| `classic.{default,minimal,verbose}.{chars,endChars}` | Vitest's own `DefaultReporter`, `MinimalReporter` (what Vitest 5 selects for AI agents, `std-env isAgent`), `VerboseReporter`, attached to the same run, writing into counting streams instead of stdout; `endChars` = output written during `onTestRunEnd` (failure details + summary) | measured |

Per MCP response (`{"t":"tokens"}`): `tool`, `tokens` = ⌈characters / 4⌉ of the text returned to
the client, `runId` when the response belongs to a run (measured; the /4 is an approximation of
real tokenizers, typically ±25 % for JSON/English).

## 2. Formulas (`Metrics.report`)

Window: runs with `status: done` since `--since` (default 30 days). A run is **full** when
`kind == full` and `testsRun ≥ 0.95 · suiteTotal`. Every other run is a **partial** run, i.e. a
full run that the classic workflow would have executed instead (assumption A1).

For a partial run *r* with pool *p*:

- `cf(p)` = the latest full run of pool *p* in the whole log (measured counterfactual).
  If none exists: `cf.wall = r.wall · suiteTotal / testsRun`, `cf.cpu = r.cpu · suiteTotal / testsRun`
  (**estimated**: linear extrapolation; under-estimates because per-file setup dominates, see perf/RESULTS.md).
- full runs avoided = number of partial runs.
- wall saved = Σ max(0, cf.wall − r.wall); CPU saved = Σ max(0, cf.cpu − r.cpu); CPU-hours = CPU saved / 3.6e6.
- vs classic Vitest (baseline pool `forks`, the Vitest default): the same with `cf(forks)` when a
  forks full run was ever measured (run one with `VTO_POOL=forks vto-daemon run --full` to calibrate).
- test-minutes saved = Σ (suiteTotal − testsRun) · (cf.testMsSum / cf.testsRun) / 60 000 (needs a measured cf).
- time-to-first-failure gained (failing runs only) = Σ max(0, cf.wall − r.ttffMs): the classic
  workflow reports failures when the command ends (an agent reads the output after the process exits).
- classic tokens for *r* (per reporter k ∈ default, minimal, verbose; only when both *r* and cf have `classic`):
  `(cf.classic[k].chars − cf.classic[k].endChars + r.classic[k].endChars) / 4`
  = the full-suite output of the passing part (measured on cf) + the failure section of this run (measured on r).
- tokens returned = Σ `tokens` records in the window; tokens saved vs k = classic_k − returned.

## 3. What is not covered (honest limits)

- A1: not every partial run replaces a full run (an agent may have run only one file by hand anyway).
  `fullRunsAvoided` is therefore an upper bound; the per-run numbers are exact.
- `cpuMs` misses child processes for `forks`/`vmForks` pools; use the CI report or the bench
  script (`dev/proc-cpu.mjs`, Linux) for tree CPU.
- Agents often pipe output through `tail`/`grep`; the classic token numbers assume the whole output
  is read. The `minimal` reporter (Vitest's agent default) is the fairest baseline and is reported separately.
- Instrumentation overhead is included in vto's own numbers (instrumented runs), not removed.

## 4. CI (`vto-daemon ci-report [--base REF] [--full] [--out FILE]`)

Runs stateless (no daemon) and prints one JSON object per pipeline run:

```json
{"v":"vto-ci/1","at":"…","runId":"r3","kind":"affected","pool":"forks","runAll":false,"durationMs":41210,"cpuMs":9800,
 "selected":412,"total":3195,"failed":0,"baseline":{"pool":"forks","durationMs":698000,"cpuMs":308500,"measuredAt":"…","measured":true},
 "savedMs":656790,"savedCpuMs":298700}
```

`baseline` = the latest full run of the same pool (else forks) recorded in `.vto/metrics.jsonl`
– keep `.vto/` in the CI cache **keyed by branch, restored only from trusted branches**
(SECURITY-REVIEW F7). CI cost = Σ durationMs × runner price; saved = Σ savedMs × runner price.
