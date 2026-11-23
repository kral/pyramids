# Limitations

## Depends on Vitest internals

- Vitest `>=4.1 <6` (developed against 5.1.1; CI tests 4.1.8 and 5.1.1, so other 4.1.x/5.x releases are accepted by the peer range but untested). The shared-mode planner relies on how Vitest 5.1.1 groups
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

## Known limits (0.1.0-alpha.3)

0.1.0-alpha.3 closed the open items of alpha.2: added globals and `navigator` overrides are reset between the files
of a shared worker (S5), testers and intervals a package registers when the test file calls it are removed after
that file (note 1), `verify` records order-dependent entries so that `check --prune` keeps them (S2), two guarded
configs in one root keep each other's quarantine entries (note 2), the shared-mode baseline is always taken after
the setup files (note 3), and the fallback directory walk of mode `auto` prunes directories (S6). What is left:

- **Who did it is read from the stack.** An equality tester, an interval, an added global or a `navigator` override
  counts as the test file's when a frame of the test file is on the synchronous part of the stack at that moment
  (also through a package function the file calls), as a project module's when another project frame is, and as a
  package's when only `node_modules` frames are. A package function that registers only after an `await` (the
  test file is then only an async frame) counts as the package's: its tester or interval stays for the worker. A
  package that registers once and remembers it (`if (installed) return`) does not register again in the next file
  after the reset removed its registration.
- **Register-once packages called from a hook or a test.** A package function such as
  `install() { if (done) return; done = true; globalThis.OncePolyfill = … }` called in `beforeAll` of several files:
  the first file of a worker gets the global, the reset deletes it after that file (it came from the test's call),
  and the package, cached for the worker, never sets it again, so every later file of the worker fails although each
  passes in forks. `check` cannot converge on this (whichever file runs first looks like the polluter). Workarounds:
  call the function at the top level of a setup file (what a setup file sets is part of the baseline and stays), or
  name the global in `keepGlobals: ['OncePolyfill']` (never tracked, never deleted, never reported).
- **Added globals: provenance and the fail-closed reset.** Own properties of the global object that a file adds
  are deleted after it, unless a package in `node_modules` created them while it was being evaluated (seen through
  Vitest's module evaluator; such a package is cached for the worker and keeps its globals), a cached project module
  created them by `Object.defineProperty` without `resetModules`, or they are named in `keepGlobals`. A plain
  assignment (`globalThis.x = …`, `window.x = …`, `Object.assign`) outside a package evaluation has no recorded
  origin and is deleted (as a fresh fork would not have it). If Vitest's module evaluator cannot be found (another
  Vitest version, a native module runner), package globals created at import are deleted too: use `keepGlobals`. A
  name that cannot be deleted stays and is reported as `added globals` (a `dirty` record and a warning with the
  default `onDirty: 'warn'`); use `onDirty: 'error'` to fail on it. In vm mode every file has its own global
  object, so nothing leaks there.
- **Assignment to an undeclared identifier in vm mode.** In a vm context (`vmThreads` / `vmForks`) a strict-mode
  assignment to an undeclared name (a typo such as `reslt = sum`) creates a global instead of throwing a
  `ReferenceError` (behaviour of Node's vm contexts, not of vitest-guard): such a test can pass in vm mode and fail in
  forks. `verify --mode vm` finds it. Shared mode throws as forks do.
- **Equality testers, intervals, globals and `navigator` overrides of project modules without `resetModules`.**
  With `resetModules: false` a project module (outside `node_modules`) is cached for the worker; what it registers
  on import is kept (as the module is) and reported as residual `equality testers` / `timers` / `added globals` /
  `navigator`. A file that does not import the module can still see it in a shared worker.
- **Order-dependent entries without known predecessors.** When `verify` finds an order-dependent failure only in
  the `planned` order, or the bisection of a long predecessor list does not reproduce it, the entry is recorded with
  `orderDependent: true` and no `after`; `check --prune` never releases it: delete it by hand and run `verify`.
- **Quarantine entries of version 1 files** carry no `config`. Such an entry counts as the current config's when the
  config lists the file, is kept (never pruned) when the file exists but the config does not list it, and is stale
  only when the file is gone.

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
