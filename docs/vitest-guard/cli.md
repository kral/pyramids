# CLI reference

Invocation (never `npx vitest-guard`: the unscoped npm name is not ours):

```sh
npm run guard -- <command> [options]            # with "guard": "vitest-guard" in package.json scripts
node node_modules/@jirikral/vitest-guard/bin/vitest-guard.mjs <command> [options]
```

Everything below is also printed by `vitest-guard --help` and `vitest-guard <command> --help` (also `vitest-guard help <command>`).

Commands: `check`, `verify`, `compare`, `hunt`. They refuse a config that is not wrapped with
`defineVitestGuardConfig` (exit 2, nothing run or written). The CLI runs your project's own Vitest (it must be installed in `--root`).

Commands and options removed in 0.2.0-alpha.0 (`plan`, `run`, `calibrate`, `scan`, `report`, `--mode auto`, `--no-plan`,
`--vto-raw`, `--no-calibrate`, `--commit-state`, ...) give a usage error (exit 2) that names what was removed; see
[Removed in 0.2.0-alpha.0](index.md#removed-in-020-alpha0).

## Exit codes

Exit codes are stable across commands:

| code | meaning | returned by vitest-guard |
|---|---|---|
| 0 | ok | all commands when nothing is wrong |
| 1 | test failures: genuine, flaky (not explained) or unexplained failures; Vitest exited non-zero (unhandled error, crashed lane); a file produced no result ("NOT RUN"); the isolated reference run produced no report; `verify`: a comparison that is incomplete, red in the `gate` order, or an order-dependent failure that was not quarantined (`--no-quarantine`) | `check`, `verify` |
| 2 | usage or config error: unknown command, bad `--mode`, missing `--config` file, vitest not installed, config not wrapped, bad `--orders`/`--sample`, `hunt` without a test file, file filters that match no test file (`check`, `verify`) | all |
| 3 | not used | |
| 4 | new quarantine: `incompatible.json` / `conflicts.json` changed (also entries released by `check --prune`), commit and re-run | `check`, `verify`, `hunt` |
| 5 | false green: passes fast, fails in isolated forks (per test or per file: a file can fail in forks outside any test) | `verify`, `compare` |

Precedence inside `check`: 1 beats 4. Inside `verify`: 5 beats 1 beats 4. Deliberate exception: `compare`
is a measurement and exits 0 on false reds (a mismatching mode is simply never recommended); only a counted
false green changes their exit code (5). `--help` and `--version` exit 0 on stdout; usage
errors print one message plus "see --help" on stderr.

## Output

`check`, `verify` and `compare` end with a summary block: a verdict (`OK`, `QUARANTINE`, `SAFE`, `FALSE GREEN`, `FAIL`, `MEASURED`), the key numbers, the exit code (`compare` always `0`) and the suggested next step. `compare` prints the mode comparison as a table; `⚠N` in a cell means N tests whose result differs from forks.

Colour is used only on an interactive terminal. `NO_COLOR=1` turns it off, `FORCE_COLOR=1` turns it on (for example in a CI log viewer that renders ANSI). In CI, pipes and files the output is plain text, and the `[vitest-guard] …` lines above the summary stay unchanged, so existing log greps keep working.

## Global options

| option | meaning |
|---|---|
| `--mode vm\|shared` | fast mode to run. Default: the mode of the config (`mode` of `defineVitestGuardConfig`, else `vm`). `isolated` is rejected (it is the reference run, started internally) |
| `--config <file>` | Vitest config to use; default: first of `vitest.config.{ts,mts,cts,js,mjs,cjs}`, `vite.config.*` in `--root` |
| `--root <dir>` | project root, default cwd |
| `--verbose` | stream Vitest's own output |
| `--no-diag` | lean runs: sets `VITEST_GUARD_DIAG=0` (no pollution diff / module-state scan) |
| `--no-reset-modules` | shared mode without `vi.resetModules()`: sets `resetModules: false` through `VITEST_GUARD_OPTS` |
| `--version`, `--help` | |

An unknown option is a usage error (exit 2; a typo such as `--no-hnt` is not silently dropped).

## check

`vitest-guard check [filters...] [--prune] [--retries N] [--no-confirm] [--no-hunt] [--compare]`

Runs the suite in the fast mode, then re-runs every
failing file in isolated forks and compares per test:

- fails in forks too: genuine failure, exit 1;
- passes in forks, fails fast, **fails alone** in the fast mode on every retry: quarantined for that mode
  (`incompatible.json`), exit 4;
- passes alone but fails again after the files that ran before it in the same worker (replayed in recorded order):
  deterministic order dependence: quarantined with an `after` list (shared mode also records the pair in
  `conflicts.json`, which `verify` reports as a known conflict);
- passes on a retry under the same conditions: FLAKY, not quarantined, exit 1 (a failure that was not explained is
  never reported as ok);
- a file that fails in the fast run, passes in forks, and whose group already runs isolated, or that is already
  quarantined: reported as UNEXPLAINED, exit 1.

Options: `--retries N` confirmation re-runs (default 2); `--no-confirm` quarantines every fast-only failure without
confirming; `--no-hunt` skips predecessor replay (a pass on retry is then FLAKY); `--prune` first re-runs the
quarantined files in the fast mode and releases those that pass (a false-green entry only when it also passes in
isolated forks, an order-dependent one only when a replay after its recorded `after` files passes; one without
`after` is never released; entries another config wrote are never pruned or reported as stale); `--compare` runs `compare` afterwards. Filters are Vitest file filters.

Prints a layer self-time line, the leakiest files by heap delta, dirty file starts and ignored volatile modules.

## verify

`vitest-guard verify [filters...] [--sample N|all] [--seed S] [--orders a,b] [--lanes N] [--no-quarantine]`

Compares every test of the fast mode with isolated forks. Fast side runs in several orders:

| order | what it is |
|---|---|
| `gate` | what `vitest run` does (Vitest's sequencer, configured workers, quarantine applied) |
| `forward` | one worker per project, sorted file order |
| `reversed` | one worker per project, reverse order (forward + reversed put every pair in both orders) |
| `shuffle` | one worker per project, seeded shuffle (`--seed`) |

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
never runs twice at the same time. `--sample N` compares a seeded random sample and
marks the record incomplete (the shared-mode warning of `vitest run` then stays). Results: false green (passes
fast, fails isolated) -> exit 5; a lane or the reference that did not report every file it was given -> exit 1 and no
record is written; a false red in the `gate` order (not quarantined: run `check`) or one not quarantined because of
`--no-quarantine` -> exit 1; a false red that was quarantined -> exit 4; otherwise 0.
Without `--no-quarantine`, false-green files and files failing in a non-gate order are quarantined; the latter as
`orderDependent: true` with the files they failed after (`after`: the shortest failing lane prefix, bisected when it
is longer than 20 files), so that `check --prune` keeps them until a replay of that order passes. The record goes to
`.vitest-guard/run/verify-<mode>.json`. Defaults: `--sample all`, `--seed 1`.

Shared mode and `conflicts.json`: since 0.2.0-alpha.0 nothing keeps a recorded pair apart in a plain run (the
planner is gone). `check --mode shared` therefore quarantines the victim of an order-dependent failure (it runs in
isolated forks from then on) and records the pair in `conflicts.json` as well; `verify` reports a false red in a
single-worker order (`forward`, `reversed`, `shuffle`) for a recorded pair as a "known conflict".

## compare

`vitest-guard compare [--sample N|all] [--project a,b] [--seed S]`

Per project: runs a sample (default 30, `all` = every file) in forks, vm and shared; reports CPU seconds (wall
seconds where `/proc` is unavailable, i.e. not Linux), result mismatches against forks and files that fail to load in a fast mode (with the cause, see
[troubleshooting.md](troubleshooting.md)), and recommends the fastest
mode without mismatches, or forks when it saves less than 10 %. Writes `.vitest-guard/run/compare.json`. A random
sample can miss the few heavy files that decide the result: use `--sample all` for decisions.

## hunt

`vitest-guard hunt <victim> [--before a,b,c]`: bisects which earlier file of the same shared worker makes `<victim>`
fail (binary search over the predecessors recorded in the last run logs, or `--before`). `<victim>` is a test path
relative to the root as printed by `vitest list`. Records the edge in `conflicts.json` (informational: a plain run does not keep the pair apart, `check --mode shared`
quarantines the victim) and exits 4; exit 0 when no
polluter was found; exit 2 for a missing or unknown victim.

## Examples

```sh
vitest-guard compare --sample all                 # pick modes
vitest-guard check --mode shared --prune          # run, quarantine, release fixed files
vitest-guard verify --mode shared --sample all    # nightly: exit 5 = false green
vitest-guard verify --mode shared --orders gate,shuffle --seed 7 --no-quarantine
vitest-guard hunt test/b.test.ts --before test/a.test.ts,test/c.test.ts
```
