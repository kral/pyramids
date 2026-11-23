# CLI reference

Invocation (never `npx vitest-guard`: the unscoped npm name is not ours):

```sh
npm run guard -- <command> [options]            # with "guard": "vitest-guard" in package.json scripts
node node_modules/@jirikral/vitest-guard/bin/vitest-guard.mjs <command> [options]
```

Everything below is also printed by `vitest-guard --help` and `vitest-guard <command> --help` (also `vitest-guard help <command>`).

Commands `check verify compare calibrate plan run hunt` refuse a config that is not wrapped with
`defineVitestGuardConfig` (exit 2, nothing run or written). `scan` and `report` do not need a wrapped config (they still need Vitest installed in `--root`). The
CLI runs your project's own Vitest (it must be installed in `--root`).

## Exit codes

Exit codes are stable across commands:

| code | meaning | returned by vitest-guard |
|---|---|---|
| 0 | ok | all commands when nothing is wrong |
| 1 | test failures: genuine, flaky (not explained) or unexplained failures; Vitest exited non-zero (unhandled error, crashed lane); a planned file produced no result ("NOT RUN"); the isolated reference run produced no report; `verify`: a comparison that is incomplete, red in the `gate` order, or an order-dependent failure that was not quarantined (`--no-quarantine`) | `check`, `run`, `verify` |
| 2 | usage or config error: unknown command, bad `--mode`, missing `--config` file, vitest not installed, config not wrapped, bad `--orders`/`--sample`, `hunt` without a test file, file filters that match no test file (`check`, `verify`) | all |
| 3 | run all | never (used by vto's selection tools) |
| 4 | new quarantine: `incompatible.json` / `conflicts.json` changed (also entries released by `check --prune`, files added by `scan --quarantine`), commit and re-run | `check`, `run`, `verify`, `hunt`, `scan` |
| 5 | false green: passes fast, fails in isolated forks (per test or per file: a file can fail in forks outside any test) | `verify`, `compare`, `calibrate` |

Precedence inside `check`: 1 beats 4. Inside `verify`: 5 beats 1 beats 4. Deliberate exception: `compare` /
`calibrate` are measurements and exit 0 on false reds (a mismatching mode is simply never recommended); only a counted
false green changes their exit code (5). `--help` and `--version` exit 0 on stdout; usage
errors print one message plus "see --help" on stderr.

## Output

`check`, `verify` and `compare` end with a summary block: a verdict (`OK`, `QUARANTINE`, `SAFE`, `FALSE GREEN`, `FAIL`, `MEASURED`), the key numbers, the exit code (`compare` always `0`) and the suggested next step. `compare` prints the mode comparison as a table; `⚠N` in a cell means N tests whose result differs from forks.

Colour is used only on an interactive terminal. `NO_COLOR=1` turns it off, `FORCE_COLOR=1` turns it on (for example in a CI log viewer that renders ANSI). In CI, pipes and files the output is plain text, and the `[vitest-guard] …` lines above the summary stay unchanged, so existing log greps keep working.

### Animated swan (`compare`, calibration)

While `compare` measures (also `check --compare` and the automatic calibration of mode `auto`), a small animated swan is
drawn on **stderr**, after 0.4 s, so quick runs never flash it. It is only drawn on an interactive terminal: never in CI
(`CI`, `GITHUB_ACTIONS` or `TF_BUILD` set, any non-empty value), when stderr is redirected to a file or pipe, or with
`TERM=dumb`. Because it uses stderr only, `compare | tee log` in a terminal still shows it (stdout stays clean). It adapts to
the terminal: on narrow terminals the water shrinks and the label is cut with `…`, below about 50 columns (or a terminal
shorter than 10 rows) a single status line replaces it. Lines printed meanwhile appear above it. Ctrl-C, SIGTERM and SIGHUP
restore the cursor.

| variable | effect |
|---|---|
| `VTO_NO_ANIMATION=1` | no swan at all (exactly the value `1`) |
| `VTO_ASCII=1` | plain line art instead of block characters (also the default on the old Windows console host) |
| `NO_COLOR=1` / `FORCE_COLOR=1` | colour off / on, as for the summary |

PowerShell: `$env:VTO_NO_ANIMATION='1'; npm run guard -- compare`; cmd: `set VTO_NO_ANIMATION=1 && npm run guard -- compare`.
Only `compare` animates; `check` and `verify` print the summary only. The same swan is used by `vto run` and
`vto savings`.

## Global options

| option | meaning |
|---|---|
| `--mode vm\|shared\|auto` | fast mode to run. Default: the mode of the config (`mode` of `defineVitestGuardConfig`, else `vm`). `isolated` is rejected (it is the reference run, started internally) |
| `--config <file>` | Vitest config to use; default: first of `vitest.config.{ts,mts,cts,js,mjs,cjs}`, `vite.config.*` in `--root` |
| `--root <dir>` | project root, default cwd |
| `--verbose` | stream Vitest's own output |
| `--no-diag` | lean runs: sets `VITEST_GUARD_DIAG=0` (no pollution diff / module-state scan) |
| `--no-reset-modules` | shared mode without `vi.resetModules()`: sets `resetModules: false` through `VITEST_GUARD_OPTS`; the planner then adds transitive `vi.mock` edges |
| `--commit-state` | keep `durations.json` and `pollution.json` in `.vitest-guard/` (committed) instead of `.vitest-guard/run/` |
| `--version`, `--help` | |

Unknown options are ignored with a warning on stderr (a typo such as `--no-hnt` is not silently dropped).

## check

`vitest-guard check [filters...] [--prune] [--retries N] [--no-confirm] [--no-hunt] [--no-plan] [--lanes N] [--vto-raw dir] [--compare] [--no-calibrate] [--calibrate-sample N]`

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
quarantined files in the fast mode and releases those that pass (a false-green entry only when it also passes in
isolated forks, an order-dependent one only when a replay after its recorded `after` files passes; one without
`after` is never released; entries another config wrote are never pruned or reported as stale); `--compare` runs `compare` afterwards; in `auto`
mode the first run calibrates when `modes.json` is missing (`--no-calibrate` skips, `--calibrate-sample N` sets
files per group, default 20). Filters are Vitest file filters.

Prints a layer self-time line, the leakiest files by heap delta, dirty file starts and ignored volatile modules.

## verify

`vitest-guard verify [filters...] [--sample N|all] [--seed S] [--orders a,b] [--lanes N] [--no-quarantine] [--no-plan]`

Compares every test of the fast mode with isolated forks. Fast side runs in several orders:

| order | what it is |
|---|---|
| `gate` | what `vitest run` does (Vitest's sequencer, configured workers, quarantine applied) |
| `forward` | one worker per project, sorted file order |
| `reversed` | one worker per project, reverse order (forward + reversed put every pair in both orders) |
| `shuffle` | one worker per project, seeded shuffle (`--seed`) |
| `planned` | the planner's lanes; needs `--mode shared` |

Default orders: vm `gate,reversed`; shared `gate,forward,reversed`. On Vitest < 5 (or when the project's Vitest
version cannot be read), `--mode vm` without `--orders` skips the single-worker orders (`forward`, `reversed`,
`shuffle`). There every file of a single-worker vm run gets a fresh vm context and a fresh worker process (the
`vitest-guard:vm-file-isolation` plugin), so the file order cannot change a result. Those runs only cost time (about
as long as the forks reference). The `gate` order (workers reused, so it also sees state a file leaves in the worker
process) and the forks comparison still run. Exit codes stay the same. verify prints why it skipped them and lists
them in the summary (`orders skipped`). The record (`ordersSkipped`) still counts as a complete vm verify. An explicit
`--orders` always runs exactly the orders it names, e.g. a nightly full check on 4.1:
`vitest-guard verify --mode vm --orders gate,forward,reversed`. The lanes of one single-worker order (one per
project) run side by side, at most `--lanes` at a time (default CPUs - 1). Orders run one after another, so a file
never runs twice at the same time. `--no-plan` removes `planned` (explicitly
asking for only `planned` together with `--no-plan` is exit 2). `--sample N` compares a seeded random sample and
marks the record incomplete (the shared-mode warning of `vitest run` then stays). Results: false green (passes
fast, fails isolated) -> exit 5; a lane or the reference that did not report every file it was given -> exit 1 and no
record is written; a false red in the `gate` order (not quarantined: run `check`) or one not quarantined because of
`--no-quarantine` -> exit 1; a false red that was quarantined -> exit 4; otherwise 0.
Without `--no-quarantine`, false-green files and files failing in a non-gate order are quarantined; the latter as
`orderDependent: true` with the files they failed after (`after`: the shortest failing lane prefix, bisected when it
is longer than 20 files), so that `check --prune` keeps them until a replay of that order passes. The record goes to
`.vitest-guard/run/verify-<mode>.json`. Defaults: `--sample all`, `--seed 1`.

Shared mode and `conflicts.json`: conflict edges are applied **only by the planner**: `plan`, `run`, `check --mode shared`
(unless `--no-plan`) and the `planned` order of `verify`. The `gate` order is plain `vitest run` and ignores them, so a
recorded pair can still fail there: `verify --mode shared` then reports a false red in order `gate` and exits 4 even after
`check` converged (exit 0). A pair that fails only in the single-worker orders (`forward`, `reversed`, `shuffle`) is
reported as "known conflicts" instead. To converge, gate shared mode with `vitest-guard run` (planner) and verify it with
`--orders planned,forward,reversed`; keep `vm` (quarantine applies to plain `vitest run`) for a PR gate that is plain
`vitest run`.

## compare / calibrate

`vitest-guard compare [--sample N|all] [--project a,b] [--seed S] [--no-write]`
`vitest-guard calibrate [--sample N] ...` is `compare` with default sample 20.

Per project: runs a sample (default 30, `all` = every file) in forks, vm and shared; reports CPU seconds (wall
seconds where `/proc` is unavailable, i.e. not Linux), result mismatches against forks, and recommends the fastest
mode without mismatches, or forks when it saves less than 10 %. Writes `compare.json` and (unless `--no-write`)
`modes.json`. A random sample can miss the few heavy files that decide the result: use `--sample all` for decisions.

`modes.json` is only read by mode `auto`; with `mode: 'vm'` it is written but unused. **Filters:** `check <filter> --compare`
(and the automatic calibration of `auto`) compares only the filtered files / the small sample and **overwrites `modes.json`**
from them, replacing an earlier `compare --sample all` result. For decisions run `compare --sample all` and, if you do not want
the file changed, pass `--no-write` to `compare` (`check --compare` has no such switch).

## plan / run

`vitest-guard plan [--lanes N] [--vto-raw dir]`: builds the conflict graph and lanes per project, writes
`.vitest-guard/run/plan.json`, prints a summary. Lanes default to CPUs minus 1. `--vto-raw` reads vto raw records for
module graphs and durations.

`vitest-guard run [--no-heal] [--no-replan] [--lanes N] ...`: always shared mode. Executes the plan (one Vitest process
per lane plus one for the isolated bucket). By default self-healing, identical to `check --mode shared` (so all
`check` options apply). `--no-heal` only runs and reports (exit 1 on failures); `--no-replan` with `--no-heal`
reuses the stored `plan.json`. `run` is the way to apply `conflicts.json`: plain `vitest run` in shared mode does not
separate conflicting files (see `verify` above).

## hunt

`vitest-guard hunt <victim> [--before a,b,c]`: bisects which earlier file of the same shared worker makes `<victim>`
fail (binary search over the predecessors recorded in the last run logs, or `--before`). `<victim>` is a test path
relative to the root as printed by `vitest list`. Records the edge in `conflicts.json` and exits 4; exit 0 when no
polluter was found; exit 2 for a missing or unknown victim.

## scan

`vitest-guard scan [--quarantine]`: static scan of test files for shared-mode risks (no tests run). `--quarantine`
writes the risky files into the `shared` bucket of `incompatible.json`. Exit 0.

## report

`vitest-guard report`: summary of the last run logs in `.vitest-guard/run/logs`. Exit 0.

## Examples

```sh
vitest-guard compare --sample all                 # pick modes
vitest-guard check --mode shared --prune          # run, quarantine, release fixed files
vitest-guard verify --mode shared --sample all    # nightly: exit 5 = false green
vitest-guard verify --mode shared --orders gate,shuffle --seed 7 --no-quarantine
vitest-guard hunt test/b.test.ts --before test/a.test.ts,test/c.test.ts
```
