# CLI reference

Invocation (never `npx vm-guard`; that name belongs to an unrelated npm package):

```sh
npm run guard -- <command> [options]            # with "guard": "vm-guard" in package.json scripts
node node_modules/@kral/vm-guard/bin/vm-guard.mjs <command> [options]
```

Everything below is also printed by `vm-guard --help` and `vm-guard <command> --help` (also `vm-guard help <command>`).

Commands `check verify compare calibrate plan run hunt` refuse a config that is not wrapped with
`defineVmGuardConfig` (exit 2, nothing run or written). `scan` and `report` do not need a wrapped config. The
CLI runs your project's own Vitest (it must be installed in `--root`).

## Exit codes

From `contracts/DECISIONS.md` D3:

| code | meaning | returned by vm-guard |
|---|---|---|
| 0 | ok | all commands when nothing is wrong |
| 1 | test failures: genuine, flaky (not explained) or unexplained failures; the isolated reference run produced no report | `check`, `run` |
| 2 | usage or config error: unknown command, bad `--mode`, missing `--config` file, vitest not installed, config not wrapped, bad `--orders`/`--sample`, `hunt` without a test file | all |
| 3 | run all | never (used by vto's selection tools) |
| 4 | new quarantine: `incompatible.json` / `conflicts.json` changed, commit and re-run | `check`, `run`, `verify`, `hunt` |
| 5 | false green: passes fast, fails in isolated forks | `verify` |

Precedence inside `check`: 1 beats 4. Inside `verify`: 5 beats 4. `--help` and `--version` exit 0 on stdout; usage
errors print one message plus "see --help" on stderr.

## Global options

| option | meaning |
|---|---|
| `--mode vm\|shared\|auto` | fast mode to run. Default: `vm`, or `auto` when the config uses mode `auto`. `isolated` is rejected (it is the reference run, started internally) |
| `--config <file>` | Vitest config to use; default: first of `vitest.config.{ts,mts,cts,js,mjs,cjs}`, `vite.config.*` in `--root` |
| `--root <dir>` | project root, default cwd |
| `--verbose` | stream Vitest's own output |
| `--no-diag` | lean runs: sets `VM_GUARD_DIAG=0` (no pollution diff / module-state scan) |
| `--no-reset-modules` | shared mode without `vi.resetModules()`: sets `resetModules: false` through `VM_GUARD_OPTS`; the planner then adds transitive `vi.mock` edges |
| `--commit-state` | keep `durations.json` and `pollution.json` in `.vm-guard/` (committed) instead of `.vm-guard/run/` |
| `--version`, `--help` | |

Unknown options are ignored with a warning on stderr (a typo such as `--no-hnt` is not silently dropped).

## check

`vm-guard check [filters...] [--prune] [--retries N] [--no-confirm] [--no-hunt] [--no-plan] [--lanes N] [--vto-raw dir] [--compare] [--no-calibrate] [--calibrate-sample N]`

Runs the suite in the fast mode (shared mode: through the planner unless `--no-plan`), then re-runs every
failing file in isolated forks and compares per test:

- fails in forks too: genuine failure, exit 1;
- passes in forks, fails fast, **fails alone** in the fast mode on every retry: quarantined for that mode
  (`incompatible.json`), exit 4;
- passes alone but fails again after the files that ran before it in the same worker (replayed in recorded order):
  deterministic order dependence. shared: conflict edge in `conflicts.json`; vm: quarantined with an `after` list;
- passes on a retry under the same conditions: FLAKY, not quarantined, exit 1 (a failure that was not explained is
  never reported as ok);
- a file that fails in the fast run, passes in forks, and whose group already runs isolated, or that is already
  quarantined: reported as UNEXPLAINED, exit 1.

Options: `--retries N` confirmation re-runs (default 2); `--no-confirm` quarantines every fast-only failure without
confirming; `--no-hunt` skips predecessor replay (a pass on retry is then FLAKY); `--prune` first re-runs the
quarantined files in the fast mode and releases those that pass; `--compare` runs `compare` afterwards; in `auto`
mode the first run calibrates when `modes.json` is missing (`--no-calibrate` skips, `--calibrate-sample N` sets
files per group, default 20). Filters are Vitest file filters.

Prints a layer self-time line, the leakiest files by heap delta, dirty file starts and ignored volatile modules.

## verify

`vm-guard verify [filters...] [--sample N|all] [--seed S] [--orders a,b] [--no-quarantine] [--no-plan]`

Compares every test of the fast mode with isolated forks. Fast side runs in several orders:

| order | what it is |
|---|---|
| `gate` | what `vitest run` does (Vitest's sequencer, configured workers, quarantine applied) |
| `forward` | one worker per project, sorted file order |
| `reversed` | one worker per project, reverse order (forward + reversed put every pair in both orders) |
| `shuffle` | one worker per project, seeded shuffle (`--seed`) |
| `planned` | the planner's lanes; needs `--mode shared` |

Default orders: vm `gate,reversed`; shared `gate,forward,reversed`. `--no-plan` removes `planned` (explicitly
asking for only `planned` together with `--no-plan` is exit 2). `--sample N` compares a seeded random sample and
marks the record incomplete (the shared-mode warning of `vitest run` then stays). Results: false green (passes
fast, fails isolated) -> exit 5; false red (fails fast, passes isolated) or new quarantine -> exit 4 (note: this also
applies when the false red appeared only in the `gate` order, which is not quarantined: run `check`); otherwise 0.
Without `--no-quarantine`, false-green files and files failing in a non-gate order are quarantined. The record goes to
`.vm-guard/run/verify-<mode>.json`.

## compare / calibrate

`vm-guard compare [--sample N|all] [--project a,b] [--seed S] [--no-write]`
`vm-guard calibrate [--sample N] ...` is `compare` with default sample 20.

Per project: runs a sample (default 30, `all` = every file) in forks, vm and shared; reports CPU seconds (wall
seconds where `/proc` is unavailable, i.e. not Linux), result mismatches against forks, and recommends the fastest
mode without mismatches, or forks when it saves less than 10 %. Writes `compare.json` and (unless `--no-write`)
`modes.json`. A random sample can miss the few heavy files that decide the result: use `--sample all` for decisions.

## plan / run

`vm-guard plan [--lanes N] [--vto-raw dir]`: builds the conflict graph and lanes per project, writes
`.vm-guard/run/plan.json`, prints a summary. Lanes default to CPUs minus 1. `--vto-raw` reads vto raw records for
module graphs and durations.

`vm-guard run [--no-heal] [--no-replan] [--lanes N] ...`: always shared mode. Executes the plan (one Vitest process
per lane plus one for the isolated bucket). By default self-healing, identical to `check --mode shared` (so all
`check` options apply). `--no-heal` only runs and reports (exit 1 on failures); `--no-replan` with `--no-heal`
reuses the stored `plan.json`.

## hunt

`vm-guard hunt <victim> [--before a,b,c]`: bisects which earlier file of the same shared worker makes `<victim>`
fail (binary search over the predecessors recorded in the last run logs, or `--before`). `<victim>` is a test path
relative to the root as printed by `vitest list`. Records the edge in `conflicts.json` and exits 4; exit 0 when no
polluter was found; exit 2 for a missing or unknown victim.

## scan

`vm-guard scan [--quarantine]`: static scan of test files for shared-mode risks (no tests run). `--quarantine`
writes the risky files into the `shared` bucket of `incompatible.json`. Exit 0.

## report

`vm-guard report`: summary of the last run logs in `.vm-guard/run/logs`. Exit 0.

## Examples

```sh
vm-guard compare --sample all                 # pick modes
vm-guard check --mode shared --prune          # run, quarantine, release fixed files
vm-guard verify --mode shared --sample all    # nightly: exit 5 = false green
vm-guard verify --mode shared --orders gate,shuffle --seed 7 --no-quarantine
vm-guard hunt test/b.test.ts --before test/a.test.ts,test/c.test.ts
```
