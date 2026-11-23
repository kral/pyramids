# How it works

## Config layering

`defineVitestGuardConfig` builds the config in this order: env mode (`VITEST_GUARD_MODE`) > explicit pool of a project >
`mode` option. `VITEST_GUARD_OPTS` is merged over the options first. Projects get their mode from their own pool
(see [configuration.md](configuration.md#projects)). The resolved options travel to the setup file through `test.provide.vitestGuard` (read with `inject`).

## Setup layering

For every test file Vitest runs, in this order:

1. vitest-guard's setup (`@jirikral/vitest-guard/setup`, one bundled module `setup.bundle.mjs`, because each extra module
   costs a fetch and an evaluation per file in vm pools). Skipped with `setup: 'import'`, where your first setup file
   imports it.
2. root `setupFiles` (projects with `extends: true`), then the project's `setupFiles`.
3. shared mode only: `setup-tail.mjs`, which marks "all setup files have run". The shared-mode baseline (what the
   resets restore: `process.env`, globals, DOM) is taken there, and extensions made by setup files are not blamed on
   a test file. This needs `sequence.setupFiles: 'list'`, which vitest-guard sets; a `'parallel'` setting runs in
   list order in shared mode (with a warning), and `tail: false` is refused there (the config does not load).

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
- shared only: DOM/storage, ~40 watched globals (`Date`, `setTimeout`, `fetch`, `localStorage`, ...), own
  properties added to the global object, `navigator` properties (own and on its prototype), fake timers left on,
  mounted React roots, window/document listeners added by non-library code, singleton probes (i18next, TanStack
  Query core), built-in extensions (names added to built-in prototypes) and `expect.extend` matchers, node_modules
  export state (with diagnostics).

Anything dirty at start is reported as `[vitest-guard] <file> starts with state left by <previous file>: ...`
(`onDirty`: warn/error/silent). After each file in shared mode the resets run: `useRealTimers`,
`restoreAllMocks`, `unstubAllGlobals`/envs, unmount React roots in `act()`, remove tracked listeners, clear the
file's intervals and remove its equality testers, restore globals and DOM, delete the own properties of the global
object the file added, put `navigator` properties back to their state after the file's setup files, reset the
TanStack online/focus managers, and with `resetModules` `vi.resetModules()` plus removal of extensions the file
added. What survives is "residual" and drives conflict edges.

Who registered an equality tester or an interval, added a global or overrode a `navigator` property is read from the
synchronous part of the stack at that moment (`Object.defineProperty` / `defineProperties` /
`Reflect.defineProperty` are wrapped): a frame of the current test file makes it the file's (also when it calls a
package function that registers), another project frame a project module's, only `node_modules` frames a package's.
Globals that appear while Vitest's module evaluator evaluates a `node_modules` package are the package's. A global
created by a plain assignment (`globalThis.x = …`) has no recorded origin and counts as the file's (fail closed;
nothing sits in the prototype chain of the global object, so an assignment to an undeclared identifier still throws
a `ReferenceError`). The file's state is removed after it, a project module's only with `resetModules` (the module
is evaluated again), a package's is kept for the worker (it is cached, as its other state); `keepGlobals` names
globals that are never removed. Limits: [limitations.md](limitations.md#known-limits-010-alpha3).

## resetModules

With `isolate: false` a module cached by an earlier file keeps its first `vi.mock` binding: even identical mocks
conflict because each file creates its own `vi.fn()`. `vi.resetModules()` after every file makes the next file
evaluate its modules again. Measured without it: 308 failing tests on the heavy lab suite. `--no-reset-modules` (CLI) sets `resetModules: false` for a run.

## Integrity check (shared)

Once per worker vitest-guard records the identity of `expect`, its static methods, ~30 core matchers, the `vi.*`
functions and a few intrinsics (`Function.prototype.call/apply`, `Object.is`, `JSON.stringify`,
`Promise.prototype.then`). A later file starting with any of them replaced fails with
`[vitest-guard] integrity: ... replaced before <file>`; `check` re-runs it in forks. `expect.extend` with other names
is allowed.

## Quarantine

`.vitest-guard/incompatible.json`: `{ version, vm: { <file>: info }, shared: { <file>: info } }`; `info` has
`signature`, `tests`, `firstSeen`, `pool`, `config` (the config file that wrote it, relative to the root), and
optionally `orderDependent: true` with `after` + `reason` (order dependence) or `falseGreen: true`.
At config load, the entries for the active mode are validated and the files move to a `forks`, `isolate: true`
project, excluded from the fast project (an entry of another config applies too when it names a file of this one).
`check --prune` re-runs the current config's entries fast and removes those that pass: a false-green entry only when
it also passes in isolated forks, an order-dependent one only when a lane replay of its `after` files passes (without
`after` it is never released). Entries of another config (two guarded configs in one root) are never stale and never
pruned; a version 1 entry without `config` whose file exists but is not listed by this config is kept as well.
`conflicts.json`: `{ version, edges: [{ a: polluter, b: victim, kind: 'history', signature, seen }] }`, written by
`check --mode shared` and `hunt`; `verify` reads it to report known conflicts. Nothing else applies it.

## Lanes (verify)

`verify` runs its single-worker orders (`forward`, `reversed`, `shuffle`) as lanes: one Vitest process per project with
`VITEST_GUARD_LANE_FILE` = `{ project, files }`, `maxWorkers: 1` and `VitestGuardSequencer`, because with `isolate: false`
a project's files go to one worker in sequencer order only when `maxWorkers` is 1 (verified against Vitest 5.1.1
`groupSpecs`/`pool.run`; this is Vitest internals: see [limitations.md](limitations.md)). Lane data are validated like
all repo data ([security.md](security.md)).

## Self-healing

A shared-mode failure that passes in forks is replayed with its recorded predecessors; if it fails again, a
binary search (about log2(n)+2 runs) finds the polluting file(s). The victim is quarantined with an `after` list (shared
mode also records the edge in `conflicts.json`). If the victim fails alone in the fast mode it is quarantined without
`after`. Only a retry-pass under identical conditions is called flaky.

## Compare

`compare` runs a sample of each project in forks, vm and shared, compares results per test with forks, and
takes the fastest mode with no mismatches if it saves at least 10 % (CPU, else wall); otherwise forks. Files that fail
to load in a fast mode are reported with their cause and counted as failures of that mode. It is sample based
([limitations.md](limitations.md)). The result goes to `.vitest-guard/run/compare.json`.

## State files

| file | committed | content |
|---|---|---|
| `.vitest-guard/incompatible.json` | yes | quarantine |
| `.vitest-guard/conflicts.json` | yes | conflict edges |
| `.vitest-guard/run/` (git-ignored by its own `.gitignore`) | no | `logs/` (worker logs, lane files), `verify-<mode>.json`, `compare.json` |

### Format versions

`incompatible.json` is format version **2** (0.1.0-alpha.3: entries carry `config` and `orderDependent`);
`conflicts.json` is format version **1**. A version 1 `incompatible.json` is read as version 2 (entries without `config`; an entry whose signature
starts with `order-dependent:` gets `orderDependent: true`) and written as version 2 by the next command that
changes it; 0.1.0-alpha.2 and older then refuse it instead of pruning entries they do not understand. The
`version` field comes first. A file without it counts as version 1, so hand-written files still work. vitest-guard always writes the version it supports. Its rules:

- **Unknown fields are kept.** A load/save round trip preserves them, so a later minor version can add fields
  without breaking older copies.
- **A higher (or invalid) version is refused.** It is never misread as a version this vitest-guard knows, and it is
  never rewritten in an older layout.
  - The CLI exits 2 before it runs or writes anything: `.vitest-guard/incompatible.json has format version 3; this
    @jirikral/vitest-guard (…) understands version 2 - upgrade @jirikral/vitest-guard`.
  - The config wrapper (a plain `vitest run`) refuses to load: Vitest exits 1 with the same message. Teams in the
    middle of an upgrade can set `VITEST_GUARD_NEWER_STATE=failsafe`: then every existing test file named anywhere
    in the newer `incompatible.json` runs isolated (forks) in every mode, so nothing that a newer version
    quarantined runs fast. A newer file that names no existing test file still stops the config.
- **An unusable `incompatible.json` stops the run (fail closed).** Text that is not JSON (merge-conflict markers), a
  top level that is not an object, a `vm` / `shared` that is not an object, an unreadable file and a linked file or
  directory never read as "no quarantine": the config throws (Vitest exits 1), the CLI exits 2, and no command
  overwrites a committed file it could not parse.

0.2.0-alpha.0 no longer reads or writes `durations.json`, `pollution.json`, `plan.json`, `modes.json`, `auto.json` or
`env.json`; leftovers from older versions are ignored and can be deleted.

### Symlinks

vitest-guard does not follow links in `.vitest-guard/`. The rules:

- **Symlinks and junctions are refused.** This covers `.vitest-guard`, `run/`, `run/logs/` and any link inside
  them. The CLI exits 2 and runs nothing. Test workers print a warning and write no state. The config wrapper
  refuses to load when it would have to read the quarantine through a link (`.vitest-guard` or
  `incompatible.json` linked): a quarantine it cannot read must not turn into a fast run.
- **Directories are created private.** `.vitest-guard`, `run/` and `run/logs/` get mode 0700 on POSIX.
- **Files are written safely.** Each one is created with mode 0600 through an exclusive temp file and then renamed
  into place. Appends use `O_NOFOLLOW`.
- **Recursive deletes check first.** A recursive delete (`run/logs/` before a run) checks the whole chain before
  and after. It never starts at a link.
