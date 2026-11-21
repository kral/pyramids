# How it works

## Config layering

`defineVitestGuardConfig` builds the config in this order: env mode (`VITEST_GUARD_MODE`) > explicit pool of a project >
`mode` option. `VITEST_GUARD_OPTS` is merged over the options first. `auto` first rewrites the config into projects
(`dom`/`node`, or your projects with chosen pools) and then runs the normal path with `vm`/`shared`/`isolated` per
project. The resolved options travel to the setup file through `test.provide.vitestGuard` (read with `inject`).

## Setup layering

For every test file Vitest runs, in this order:

1. vitest-guard's setup (`@kral/vitest-guard/setup`, one bundled module `setup.bundle.mjs`, because each extra module
   costs a fetch and an evaluation per file in vm pools). Skipped with `setup: 'import'`, where your first setup file
   imports it.
2. root `setupFiles` (projects with `extends: true`), then the project's `setupFiles`.
3. shared mode only: `setup-tail.mjs`, which marks "all setup files have run" so extensions made by setup files
   are not blamed on a test file. This needs `sequence.setupFiles: 'list'`, which vitest-guard sets (skipped when you
   set `'parallel'`).

Installed through a symlink, the setup files are copied to `node_modules/.vitest-guard/` (a real path inside the
root) and that copy is used (refreshed when content differs).

## Realm shims (vm)

In a vm pool the file's context has its own `Array`, `Error`, `Map`, `Promise`, `Uint8Array`, ... but Node builtins
return objects of the worker's outer realm. vitest-guard:

- installs `Symbol.hasInstance` on the context's intrinsic constructors (`Object`, `Array`, errors, `Map`, `Set`,
  weak collections, `Promise`, `Date`, `RegExp`, buffers, typed arrays) so an outer-realm instance also counts.
  Only the same outer constructor is accepted; user subclasses keep ordinary semantics;
- registers an equality tester so `toEqual`/`toStrictEqual` adopt foreign objects while staying strict;
- copies Web globals the context lacks from the outer realm (streams, `BroadcastChannel`, `MessageChannel`,
  `CryptoKey`, `SubtleCrypto`, ...), which is what lets MSW import.

Disable with `realm: false`. Not fixed by shims: `x.constructor === Array`, prototype identity checks.

## Resets and the leak detector

Each worker keeps a store on `process` under `Symbol.for('vitest-guard.worker')` (non-writable, non-configurable
property; contents mutable). At file start vitest-guard snapshots (first file) and compares (later files):

- vm and shared: outer-realm state: `process.env` (restored after every file), `process` listeners, extra
  `process` properties, patched Node builtins;
- shared only: DOM/storage, ~40 watched globals (`Date`, `setTimeout`, `fetch`, `localStorage`, ...), fake timers
  left on, mounted React roots, window/document listeners added by non-library code, singleton probes (i18next,
  TanStack Query core), built-in extensions (names added to built-in prototypes) and `expect.extend` matchers,
  node_modules export state (with diagnostics).

Anything dirty at start is reported as `[vitest-guard] <file> starts with state left by <previous file>: ...`
(`onDirty`: warn/error/silent). After each file in shared mode the resets run: `useRealTimers`,
`restoreAllMocks`, `unstubAllGlobals`/envs, unmount React roots in `act()`, remove tracked listeners, restore
globals and DOM, reset the TanStack online/focus managers, and with `resetModules` `vi.resetModules()` plus removal
of extensions the file added. What survives is "residual" and drives conflict edges.

## resetModules

With `isolate: false` a module cached by an earlier file keeps its first `vi.mock` binding: even identical mocks
conflict because each file creates its own `vi.fn()`. `vi.resetModules()` after every file makes the next file
evaluate its modules again. Measured without it: 308 failing tests on the heavy lab suite. With
`--no-reset-modules` (CLI) the planner instead adds hard edges between a file mocking module M and files that
reach M unmocked (heavy suite: 39 files to forks, 83.9 CPU s vs 18.0).

## Integrity check (shared)

Once per worker vitest-guard records the identity of `expect`, its static methods, ~30 core matchers, the `vi.*`
functions and a few intrinsics (`Function.prototype.call/apply`, `Object.is`, `JSON.stringify`,
`Promise.prototype.then`). A later file starting with any of them replaced fails with
`[vitest-guard] integrity: ... replaced before <file>`; `check` re-runs it in forks. `expect.extend` with other names
is allowed.

## Quarantine

`.vitest-guard/incompatible.json`: `{ version, vm: { <file>: info }, shared: { <file>: info } }`; `info` has
`signature`, `tests`, `firstSeen`, `pool`, and optionally `after` + `reason` (order dependence) or `falseGreen: true`.
At config load, the entries for the active mode are validated and the files move to a `forks`, `isolate: true`
project, excluded from the fast project. `check --prune` re-runs them fast and removes those that pass.
`conflicts.json`: `{ version, edges: [{ a: polluter, b: victim, kind: 'history', signature, seen }] }`, used by the
planner only.

## Scheduler (shared)

`vitest-guard plan` per project: (1) conflict graph; hard edges from `conflicts.json`, `vi.mock('pkg')` vs the
package's importers, different factories for the same module, singleton pollution that survived the resets, and
(with `resetModules` off) transitive mock edges; soft edges between files sharing a project module with
module-level mutable state. Modules per file come from vto `fileload` data (`--vto-raw`) or the static import graph.
(2) greedy colouring balanced by duration (`durations.json`, smoothed 50/50 with each new run), a soft edge costs 25 %
of the ideal lane load, a hard edge never shares a lane, files that fit nowhere go to an isolated bucket.
(3) order inside a lane: known victims first, polluters last.

`vitest-guard run` starts one Vitest process per lane (`VITEST_GUARD_LANE_FILE` = `{ project, files }`, `maxWorkers: 1`,
`VitestGuardSequencer`) because with `isolate: false` a project's files go to one worker in sequencer order only when
`maxWorkers` is 1 (verified by the author against Vitest 5.1.1 `groupSpecs`/`pool.run`; this is Vitest internals:
see [limitations.md](limitations.md)). Lane data are validated like all repo data ([security.md](security.md)).

## Self-healing

A shared-mode failure that passes in forks is replayed with its recorded predecessors; if it fails again, a
binary search (about log2(n)+2 runs) finds the polluting file(s) and records an edge. If the victim fails alone in the
fast mode it is quarantined instead. In vm mode, `check` also replays predecessors and records `after` on the
quarantine entry. Only a retry-pass under identical conditions is called flaky.

## env.json (auto)

`.vitest-guard/run/env.json`, format `vto-env/1`, shared with the vto daemon. `{ format, producer, updatedAt, files:
{ <path>: { group, source: 'probe'|'static', env, dom, at, miss? } } }`. Precedence, strongest first, a weaker record
never replaces a stronger one: 3 DOM miss (a node-group file failed after touching a DOM global; sticky), 2 probe
(measured; `dom: true` is sticky), 1 static (source-text guess), 0 none. Routing evidence order with
`nodeEnvironment: 'node'`: pragma, recorded miss, measured probe, static signals. Workers append
`env-<pid>-<tid>.jsonl`; the next config load folds them in (atomic write, lock) and deletes them. Only
`src/envstore.mjs` writes the file.

## Calibration

`compare`/`calibrate` run a sample of each project in forks, vm and shared, compare results per test with forks, and
take the fastest mode with no mismatches if it saves at least 10 % (CPU, else wall); otherwise forks. The result
is `modes.json`. It is sample based ([limitations.md](limitations.md)).

## State files

| file | committed | content |
|---|---|---|
| `.vitest-guard/incompatible.json` | yes | quarantine |
| `.vitest-guard/conflicts.json` | yes | conflict edges |
| `.vitest-guard/durations.json`, `pollution.json` | only with `--commit-state` | else in `run/` |
| `.vitest-guard/run/` (git-ignored by its own `.gitignore`) | no | `logs/`, `plan.json`, `files-cache.json`, `settings.json`, `verify-<mode>.json`, `compare.json`, `modes.json`, `auto.json`, `env.json`, `env-*.jsonl`, lane files |

The `vitest list` result is cached in `files-cache.json` until the test directories' mtimes, the config's mtime
or the filters change.
