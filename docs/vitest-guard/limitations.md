# Limitations

## Depends on Vitest internals

- Vitest `>=5.1 <6` (developed against 5.1.1; CI tests only the version in the lockfile, 5.1.1, so 5.1.0 and later 5.x releases are accepted by the peer range but untested). The shared-mode planner relies on how Vitest 5.1.1 groups
  specs and hands them to workers (`groupSpecs` / `pool.run`): with `isolate: false` and `maxWorkers: 1`, one
  project's files go to one worker in sequencer order. A Vitest change here would break the lane model.
- It reads Vitest's JSON reporter output, `test.provide`/`inject`, `vitest list --filesOnly --json`, and the
  `BaseSequencer` of the running Vitest. A vitest-guard sequencer imports it from the project's Vitest.
- Mitigations for risks exist only where they were reproduced or confirmed in Vitest docs/source. Newer Vitest
  versions need re-validation.
- The `poolOptions` of older Vitest versions is ignored (removed in Vitest 4).

## Where it does not help (measured)

- Pure-node projects in `vm` mode: the real-world suite `node` project +9.0 % CPU vs forks (65.1 vs 59.7); vm
  contexts save per-file environment setup and part of the import cost, they do not make test code faster, and
  global access in a vm context is slower in hot code. Use `shared` or forks there.
- Suites where the gain is under 10 %: `compare` recommends forks.
- `auto` calibrated did not beat the best single mode on either validated suite (both preferred `shared`).
- Layer overhead: +2.0 to +4.0 % (vm, heavy suite), self-time 2.8-3.8 ms per file (vm), 6-8 ms (shared), 17 ms
  with diagnostics. On the real-world suite guarded vs plain was +5.7 %, within noise under load.
- Under heavy machine load a guarded run produced extra timeouts in CPU-bound tests (load-induced).

## Calibration and verify are samples

`calibrate` uses 20 files per group by default and `compare` 30: a random sample can miss the few CPU-heavy files
(vm global access) and a file outside the sample that is green only in shared mode is never compared again, because
`check` re-runs failing files only. Decide with `--sample all`, confirm `shared` with `verify --mode shared --sample
all`. A `verify --sample N` record is marked incomplete, so the config warning stays.

## Residual risks (review items M6, M7)

**M6, order-dependent false greens in shared mode** (reviewed: green in `vitest run` while 3 tests failed in forks;
`verify` and `check` did not see it because the fast side ran only in the planner's order). Fixes in the code:
`verify` runs the fast side in the order the gate uses plus forward/reversed (and optionally shuffle/planned); the
leak detector fingerprints names on built-in prototypes and `expect.extend` matchers (the tail setup file marks
the end of setup files so they are not blamed on a test); extensions a file adds are removed after it
(with `resetModules`); `vitest run` warns when no clean `verify` exists for the commit/config. Residual:
- only orders that were run are compared: a false green that needs a specific order not among gate/forward/
  reversed (or the given shuffle seed) can still pass; state of an external module that is neither exported nor
  probed is not visible; a polluter that only affects files outside the sample is not found;
- the integrity check and fingerprints are heuristics against accidents, not tamper-proof;
- with a warm Vitest cache, Vitest runs previously failed files first, so the gate order can change between runs
  (review observation); `verify` therefore also runs forward and reversed.

**M7, vm-only failure reported as flaky** (reviewed: exit 0 and no quarantine). Fixed: `check` replays the recorded
predecessors in vm mode too, labels only retry-passes under identical conditions as flaky, and never returns 0 when a
file failed and was neither quarantined nor explained (flaky and unexplained give exit 1). Residual: a failure that
needs several predecessors at once is reported as "needs a combination of files" (all candidates listed); a
non-reproducible failure stays FLAKY and blocks the gate until fixed or re-run.

## Known limits after the review 3 re-review (open items)

- **S2, order-dependent entries from `verify` are released by `check --prune`.** `verify` records an
  order-dependent false red without its predecessors (`after`) and without an "order-dependent" marker, so
  `check --prune` sees the file pass alone in the fast mode and releases it; the next `verify` quarantines it
  again. This is not a false green (the entry protects against a false red), but a nightly `verify` + `check
  --prune` job alternates between exit 4 results and never converges. Workaround: do not prune entries whose
  signature starts with `order-dependent:` by hand, or run `check` (which records `after`) instead of `verify` for
  them.
- **S5, state that is reported but not reset.** Added own properties of the global object (`globalThis.__x`,
  `window.__cfg`), properties defined on `navigator` and similar state are reported once per worker as `added
  globals` (a `dirty` record and a warning with the default `onDirty: 'warn'`), but are not removed: a later file
  in the same shared worker can still see them. Only `verify` finds a test that depends on such state. Use
  `onDirty: 'error'` to make the gate fail on it.
- **S6, the fallback directory walk of mode `auto`.** The file listing of mode `auto` uses Vitest's own globber,
  which prunes excluded directories. Only when tinyglobby cannot be resolved from the project's Vitest does `auto`
  fall back to a directory walk that visits every directory except `node_modules`, `.git` and `.vitest-guard` and
  tests the user's `exclude` per file; on a repository with large build output that costs time at every config
  load. Files that either listing misses still run, in the isolated catch-all project `auto:rest`.
- **Equality testers and intervals of project modules without `resetModules`.** With `resetModules: false` a
  project module (outside `node_modules`) is cached for the worker; an equality tester or interval it registers on
  import is kept (as the module is) and reported as residual `equality testers` / `timers`. A file that does not
  import the module can still see that tester or interval in a shared worker.
- **`navigator` overrides.** Overrides of `navigator` properties (for example `navigator.language`) are neither
  reset nor reported.

## What vitest-guard does not cover

- `constructor ===` and prototype identity checks, `Object.prototype.toString` tricks in user code.
- `require.cache` deletion, `Module._load` / `Module.prototype.require` hooks, `process.chdir`: quarantine only.
- vm: `process` listeners, patched builtins and singletons stored on `process` are reported, not restored.
- shared: state inside node_modules closures that is not visible in exports and has no probe (probes exist for
  i18next and TanStack Query core); `resetModules` resets project modules only; top-level assignments to globals outside the
  ~40 watched ones are only found by `scan` (assignments inside a test or hook are not).
- shared with `resetModules: false`: mock edges come from the static import graph only (no dynamic imports/aliases).
- The node_modules export-state detector cannot tell scratch state from leaks (stylis is ignored by default).
- Duplicate React detection finds physical copies only.
- Windows: `compare` falls back to wall time because CPU time is read from `/proc` (Linux only); path handling of
  `hunt <victim>` expects `/`-separated paths as printed by `vitest list`. The tests and measurements were done on
  Linux; Windows/macOS behaviour of the CLI is not covered by the measurements (unverified).
- A random sample-based classification: `auto` routes by configured environment by default; moving DOM-free files
  (`nodeEnvironment: 'node'`) can change semantics and is opt-in.
- Not a security boundary ([security.md](security.md)).
