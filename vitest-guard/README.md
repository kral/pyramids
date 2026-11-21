# vitest-guard

> **Warning:** `@kral/vitest-guard` is not published to npm yet. Do not run `npx vitest-guard`: the unscoped name is not ours, and whoever registers it would run their code on your machine. Use the local copy (`node <path-to-vto>/vitest-guard/bin/vitest-guard.mjs`) or an npm script.


*Czech version: [README.cs.md](README.cs.md).*

vitest-guard makes the two fast Vitest 5.1.1 modes safe to switch on:

| mode | Vitest | heavy suite, 312 files / 3193 tests, CPU s |
|---|---|---|
| `isolated` (Vitest default) | `pool: 'forks'`, `isolate: true` | 480–498 |
| **`vm`** | `pool: 'vmThreads'` | **66 (−86 %)**, layer overhead +2–4 % |
| **`shared`** | `pool: 'threads'`, `isolate: false` + per-file `resetModules` (+ planner) | **16.1 (−97 %)** |

Both modes fail exactly the same 5 tests as forks on that suite (pre-existing failures). Bare `isolate:false`
fails 308–311 (see `vi.mock` below).

> **The gain depends on the project.** vm contexts save the per-file environment setup (jsdom) and part of the
> import cost; they do not make test code faster, and global access in a vm context is slower in hot code. On
> the real repo `the real-world suite` (validation run, full suite, CPU) vm vs forks was only **−40.8 % in total: the
> `dom` project −53.5 %, the pure-node project +9.0 % (slower than forks)**; shared vs the repo's existing bare
> vmThreads −32.9 %. For pure-node projects (no jsdom/happy-dom, few heavy imports) prefer `shared` or keep
> `forks`. Measure per project with `vitest-guard compare --sample all` (or `check --compare`); see Measurements. Everything here is backed by reproductions in the lab `vmguard-lab`: React 19,
RTL 16, jsdom 31, happy-dom 21, MSW 3, i18next 27, TanStack Query 5, better-sqlite3, Node 22, 2 shared cores.
Mitigations exist **only** for risks that reproduced or that the Vitest docs and source confirm.

## Documentation

Full documentation (getting started, modes, CLI, configuration, internals, CI, troubleshooting, security,
limitations): [../docs/vitest-guard/index.md](../docs/vitest-guard/index.md).

## Quick start

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { defineVitestGuardConfig } from '@kral/vitest-guard';

export default defineVitestGuardConfig(
  defineConfig({ plugins: [react()], test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'] } }),
  { mode: 'vm' }, // or 'shared'
);
```

`defineVitestGuardConfig`:
- puts `@kral/vitest-guard/setup` **first** in `setupFiles` (one bundled module; every setup module costs a fetch and an
  evaluation per test file in vm pools);
- sets the pool. `vm` → `vmThreads` plus a sane `vmMemoryLimit`. `shared` → `threads` + `isolate:false`;
- quarantine: files in `.vitest-guard/incompatible.json` (for the mode) run in a sibling `forks` project. Without a
  quarantine no `projects` are created, because a single inline project costs ~4 % CPU;
- `server.deps.inline`: only what you pass in `inline`. No package in the lab needed inlining. Warns when only
  one of react / react-dom is inlined;
- warns about `test.poolOptions` (removed in Vitest 4 and silently ignored).

Switches: `VITEST_GUARD_MODE=vm|shared|isolated|off`, `VITEST_GUARD_OPTS='{"realm":false}'` (JSON options),
`VITEST_GUARD_DIAG=1` (diagnostics), `VITEST_GUARD_PROFILE=1` (section timings in the run log),
`VITEST_GUARD_IGNORE_QUARANTINE=1`.

### Vitest `projects`

Supported since commit `2d7ddf9` (validated on the real-world suite in all modes, `verify` and `check`); tools that
work around a missing projects support in vitest-guard can drop that workaround.

Each inline project is wrapped separately and **keeps its own pool**:
- `vmThreads`/`vmForks` → vm mode;
- `isolate:false` → shared;
- another explicit pool (`forks`, `threads`) → left as is, only logged;
- no pool → the `mode` option.

`VITEST_GUARD_MODE` overrides every project, which is what the CLI uses for checks and isolated re-runs. The vitest-guard
setup runs first in every project, before root and project `setupFiles`. Quarantine is per project: a
`<project>:isolated` sibling in `forks` holds just that project's quarantined files. The planner builds lanes per
project (one process = one project). Projects given as a path or glob (`'packages/*'`), or as functions, are not
wrapped; vitest-guard prints a warning (wrap those configs themselves). A config exported as a function: call it and
pass the object. Validated on the `the real-world suite` repo (projects `dom` + `node`, both vmThreads).

### `mode: 'auto'`: DOM group and node group, each in its best mode

```ts
export default defineVitestGuardConfig(config, { mode: 'auto' });
```

The gain of a fast pool depends on the files. vm contexts save the per-file jsdom setup; pure-node files gain
nothing from them and pay for slower global access in hot code. `auto` therefore splits the suite into two groups
and picks a mode per group:

- **Routing by the configured environment (default)**: a file belongs to the `dom` group when its configured
  environment (`@vitest-environment` pragma, else the project or root `environment`) is jsdom/happy-dom, otherwise
  to `node`. Moving jsdom-configured files that never touch the DOM elsewhere without changing their environment
  costs 2–3× CPU (jsdom is rebuilt per file in forks), and changing their environment changes semantics, so that
  is **opt-in**: `nodeEnvironment: 'node'`.
- **With `nodeEnvironment: 'node'`**, files of a DOM-configured suite move to the node group, which runs with
  `environment: 'node'`. The evidence is used most trusted first:
  1. an explicit pragma (never overridden);
  2. a recorded DOM miss (self-healing, below), which is sticky;
  3. **measured** DOM access from `.vitest-guard/run/env.json`;
  4. **static** signals: `.tsx`/`.jsx`; imports of `@testing-library/react|dom|user-event|jest-dom`, `react-dom`,
     `jsdom`, `happy-dom`; `render(`/`renderHook(`/`screen.*`; `document.`/`window.`/`localStorage.` usage →
     dom; otherwise node.
- **`.vitest-guard/run/env.json`** uses the format **`vto-env/1`** (vto `mcp/PROTOCOL.md` §9), shared with the vto
  daemon: `{ format, producer, updatedAt, files: { <path>: { group, source: 'probe'|'static', env, dom, at } } }`.
  - vitest-guard's own probe (dom group) writes `source: 'probe'`: getter traps on DOM globals plus a
    **MutationObserver** on the document, so renders through references captured before the probe (RTL
    `screen`, `document.body` grabbed at import) count.
  - A DOM miss is stored as a probe entry with `dom: true` and the extension field `miss: { key }`.
  - Entries of other producers are kept, and a measurement is never replaced by a static entry. Writes are
    atomic (tmp + rename).
  - vitest-guard deletes only its own per-worker record files (`.vitest-guard/run/env-<pid>-<tid>.jsonl`) after folding
    them in; `env.json` is never deleted and is not under the cleaned `run/logs/`.
- **Generated projects** (no user `projects`): `dom` (your environment) and `node` (`environment: 'node'`).
  Empty groups are omitted. With **user `projects`** (supported since `2d7ddf9`), your split is kept and only the
  mode of each project is chosen from its environment. Explicit pools are replaced unless `respectPools: true`.
- **Mode per group**: `autoModes` in the config (override, e.g. `{ dom: 'vm', node: 'isolated' }`) >
  `.vitest-guard/run/modes.json` > defaults `dom → vm`, `node → shared`. `modes.json` is written by `vitest-guard calibrate`
  (20 files per group), by `vitest-guard compare --sample all`, and **automatically by the first `vitest-guard check`** of
  an auto config. Each measures forks vs vm vs shared per group and takes the fastest mode without result
  differences, or forks when it saves less than 10 %. `check` on an auto config runs in mode `auto`: each group in
  its own mode, quarantine entries go into the bucket of the file's group mode.
- **Self-healing** (with `nodeEnvironment: 'node'`):
  - in the node group, record-only traps watch the DOM globals that node does not have (they return `undefined`,
    so `typeof window` checks keep working);
  - a file that **fails** after touching one, or fails with `document is not defined`, gets an extra error
    `[vitest-guard] auto: … touched the DOM global 'document' but was classified as pure node …`, is recorded as a DOM
    miss, and runs in the dom group from the next run on;
  - library feature detection in passing files never moves a file;
  - a dom-group file that never touches the DOM is demoted by the probe on the next run;
  - files whose imports touch DOM globals at import time (jest-dom, RTL) stay in dom.

### Options (`defineVitestGuardConfig(config, options)`)

| option | default | meaning |
|---|---|---|
| `mode` | `'vm'` | `'vm'` / `'shared'` (for projects without an explicit pool) / `'auto'` (per-group mode, see above) |
| `autoModes` | – | `auto`: mode per group/project, e.g. `{ dom: 'vm', node: 'shared' }`; beats `modes.json` |
| `respectPools` | `false` | `auto` with user `projects`: keep explicit project pools |
| `nodeEnvironment` | `null` | `auto`: `'node'` = move DOM-free files of a DOM-configured suite to the node group with environment node (opt-in) |
| `memoryLimit` | `autoMemoryLimit()` | overrides `vmMemoryLimit` |
| `inline` | `[]` | extra `server.deps.inline` |
| `onDirty` | `'warn'` | dirty state at file start: `'warn'` / `'error'` / `'silent'` |
| `react` | `true` | duplicate React = error. `'warn'` = warning, `false` = off |
| `realm` | `true` | vm: `Symbol.hasInstance` shims, realm equality tester, missing Web globals |
| `restoreEnv` / `reset` | `true` | restore `process.env` / shared-mode resets |
| `resetModules` | `true` | shared: `vi.resetModules()` after every file. **Required for `vi.mock` correctness** |
| `integrity` | `true` | shared: integrity check of `expect` / matchers / `vi` at file start (see Security) |
| `diag` | CLI only | pollution diff at file end, residual after reset, node_modules export-state scan (costs CPU) |
| `setup` | `'file'` | `'import'`: your first setup file starts with `import '@kral/vitest-guard/setup'` (one module less per file) |
| `alwaysProjects` | `false` | create `projects` even without a quarantine |
| `sharedPool` | `'threads'` | `'forks'` for shared mode |
| `ignoreModules` | `['stylis/…']` | node_modules paths whose exports hold parser scratch state (not reported as leaks) |

## CLI

```
node <path-to-vto>/vitest-guard/bin/vitest-guard.mjs check  [--mode vm|shared] [--prune] [filters…]
node <path-to-vto>/vitest-guard/bin/vitest-guard.mjs verify [--mode vm|shared] [--sample N|all] [--seed s]
node <path-to-vto>/vitest-guard/bin/vitest-guard.mjs plan   [--lanes N] [--vto-raw <dir>] [--no-reset-modules]
node <path-to-vto>/vitest-guard/bin/vitest-guard.mjs run    [--lanes N] [--no-heal] [--no-diag] [--no-reset-modules]
node <path-to-vto>/vitest-guard/bin/vitest-guard.mjs hunt   <file> [--before a,b,c]
node <path-to-vto>/vitest-guard/bin/vitest-guard.mjs scan   [--quarantine]
node <path-to-vto>/vitest-guard/bin/vitest-guard.mjs report
node <path-to-vto>/vitest-guard/bin/vitest-guard.mjs compare   [--sample N|all] [--project a,b] [--no-write]
node <path-to-vto>/vitest-guard/bin/vitest-guard.mjs calibrate [--sample N]
```

- **check**: runs the suite in the fast mode and re-runs failing files isolated in `forks`, comparing **per test**.
  A test that passes isolated but fails fast puts its file into `.vitest-guard/incompatible.json` with a normalised
  error signature. In shared mode it first bisects for the polluter (hunt). If one is found, the pair goes to
  `.vitest-guard/conflicts.json` instead of the quarantine, and the next plan separates the two files. Before quarantining, the file is re-run once in the fast mode. If it passes, it is reported as FLAKY (typically
  timeouts under load) and not quarantined (`--no-confirm` skips this). `--prune`
  releases quarantined files that pass in the fast mode again.
- **verify**: runs a sample both fast and isolated and compares every test. A *false green* (passes fast, fails
  isolated) exits with 5. Real example: the realm shims make vm more tolerant than forks + jsdom.
- **plan / run**: the shared-mode planner (below). `run` is self-healing.
- **hunt**: bisects the files that ran before the victim in the same worker (order from the run log).
- **scan**: static scan for shared-mode risks. `--quarantine` quarantines them directly.
- **report**: leakiest files by heap, dirty file starts, layer self-time, volatile modules.
- **compare** (also `check --compare`): per project, runs a sample (`--sample N`, default 30; use `--sample all`
  for decisions) in forks, vm and shared, measures the CPU time of the whole Vitest process tree, counts tests whose
  result differs from forks, and recommends a mode per project: the fastest mode without mismatches, or forks when
  it saves less than 10 %. Results go to `.vitest-guard/run/compare.json`.

Exit codes (contracts/DECISIONS.md D3): `0` ok, `1` test failures (genuine, flaky or unexplained), `2` usage or config
error (e.g. config not wrapped), `4` quarantine/conflict state changed (commit `.vitest-guard/incompatible.json` /
`conflicts.json` and re-run), `5` false green in `verify`. (`3` = run all belongs to vto's selection tools and is
not returned.) `vitest-guard --help` and `vitest-guard <command> --help` list every option.

Files:
- **commit** only `.vitest-guard/incompatible.json` and `.vitest-guard/conflicts.json` (protect them with CODEOWNERS). They
  are rewritten only when their content changes, so `vto affected` and similar tools don't see spurious config
  changes.
- everything volatile lives in `.vitest-guard/run/` and is **git-ignored automatically** (vitest-guard writes
  `.vitest-guard/run/.gitignore` containing `*`): run logs (`run/logs/`), lanes, `durations.json`, `pollution.json`,
  `plan.json`, `files-cache.json`, `settings.json`, `verify-*.json`, `compare.json`, and for `auto` `env.json` (classification evidence) and `modes.json` (calibrated modes).
- `--commit-state` keeps `durations.json` and `pollution.json` next to the committed files, for teams that want
  the same plan on every machine. Volatile files written by older versions into `.vitest-guard/` are moved into `run/`
  on the next CLI run (commit their removal).

## Security: vm and shared are **not** security isolation

`vmThreads` and `isolate:false` share the process, Node builtins and `process`. Shared mode also shares the
module registry and the realm. A test file or a dependency can tamper with `expect`, matchers, `vi`, `node:*`
or vitest-guard's own state for **later files in the same worker**, and those files then pass whatever they assert
(false green).

- **Security-critical gates** (CODEOWNERS-protected tests for authorisation, crypto, audit) must run in `isolated`
  mode (`VITEST_GUARD_MODE=isolated`, i.e. `forks` + `isolate:true`), not as part of the fast run.
- In shared mode vitest-guard runs a **cheap integrity check**. Once per worker it records the identity of:
  - `expect` and its static methods;
  - ~30 core matchers (`toBe`, `toEqual`, `toThrow`, `resolves`, `not`, …);
  - the `vi.*` functions;
  - a few intrinsics (`Function.prototype.call/apply`, `Object.is`, `JSON.stringify`, `Promise.prototype.then`).

  It compares them at every file start. On a mismatch **the file fails** (`[vitest-guard] integrity: … replaced`);
  `check` re-runs it isolated and hunts the polluter. `expect.extend()` with other names (jest-dom) is allowed.
  Disable with `integrity: false`.
- The vitest-guard worker store is a non-writable, non-configurable `Symbol` property of `process`, but its contents can
  still be mutated by test code. The integrity check guards against accidents and naive tampering, not against a
  targeted attacker who can run code in a test.
- **Data in `.vitest-guard/`** is validated (F9). Only these entries reach `include`, plans and hunts: literal,
  normalised, repo-relative paths of existing files inside the repository (no `..`, absolute paths, glob
  metacharacters or symlinks pointing outside) that match the project's `include`, match none of its `exclude`
  globs, and that Vitest itself lists. Anything else is ignored with a warning. The same applies to
  `VITEST_GUARD_LANE_FILE`, `conflicts.json`, `pollution.json`, `durations.json` and `hunt --before`.
- **Temp files** (F8): Vitest JSON reports go to a fresh private `mkdtemp` directory (0700, unpredictable name).
  They are read without following symlinks (`O_NOFOLLOW`), and only if the directory and the file belong to the
  current user, the directory is 0700 and the file has a single link. The directory is removed afterwards.

Regression tests for the PoCs are in `test/security.test.mjs`:
- PoC 8: symlinks planted at the old predictable paths are neither clobbered nor read;
- PoC 9: `scripts/release-helper.mjs` listed in `incompatible.json` is not executed;
- F12: a tampered `toBe` makes the next file fail; a control run with the check off shows the false green.

## Risks of `vm` mode (vmThreads)

Every test file gets its own `vm` context. node_modules code is evaluated inside it again, so library singletons
are per file. **Only the worker's outer realm is shared**: Node builtins, `process`, native addons, and the globals
the environment copies from Node (`structuredClone`, `fetch`/`Response`, `Buffer`, `AbortController`,
`MessageChannel`…).

| risk | reproduced? | mitigation | residual risk |
|---|---|---|---|
| cross-realm `instanceof`, `toBeInstanceOf`, `toThrow(Error)`, `toStrictEqual` on objects from builtins and copied globals (fs errors, `fs/promises` and `util.promisify` promises, `readdirSync` arrays, `structuredClone`, `Response.json()`, `arrayBuffer`, fetch errors, `MessageChannel` data) | **yes**: 21/53 checks fail only in vm (jsdom), 28/53 (happy-dom). Component code branches differently too (`data instanceof Array`) | `Symbol.hasInstance` shims on the context's intrinsic constructors that accept **only** the same outer-realm constructor (user subclasses keep normal semantics), and an equality tester that shallowly adopts foreign objects and keeps `toStrictEqual` strict | `x.constructor === Array` or prototype checks in user code. After the fix, only failures that also fail in forks remain |
| objects created by node_modules code | no (node_modules runs inside the context) | – | – |
| missing Web globals in the vm context (jsdom: streams, `CompressionStream`, `CryptoKey`, `SubtleCrypto`, `crypto.subtle`; happy-dom: `BroadcastChannel`, `MessageChannel`/`Port`…) | **yes**: **MSW fails at import**, `crypto.subtle.digest` fails | missing globals are copied from the outer realm | MSW + happy-dom fails in forks too |
| duplicate React / "Invalid hook call" | **no** (inline / optimizer variants never produced it) | detector: realpath of `react` from the root and from declared React libraries. Fails fast with a clear message | detects physical copies only |
| state through node_modules singletons | **no** (per file, like forks) | – | – |
| state through the **outer realm**: `process.env` (incl. `vi.stubEnv` without unstub), `process` listeners, singletons stored on `process`, monkey-patched `node:http` | **yes** | leak detector names the previous file. `process.env` is **restored** after every file | listeners and builtin patches are only reported. `check` quarantines the victim |
| memory: `vmMemoryLimit` default (`totalmem / maxWorkers`) never triggers before the box runs out of RAM. `poolOptions.vmThreads.memoryLimit` is ignored | **yes** (120 files plateau at ~330 MB; a `process` leak grows to 1.1 GB; a 300 MB limit gives 7 recycles and +44 % CPU) | `autoMemoryLimit = min(50 % RAM / workers, 60 % V8 heap limit)`, min. 512 MB. Per-file heap sampling and the leakiest-files report | outer-realm leaks accumulate until a recycle |
| `require.cache` delete + re-require, `Module.prototype.require` / `Module._load` hooks, `process.chdir` | **yes** (`server.deps.inline` does not help) | cannot be fixed in the layer, so `check` quarantines to forks | – |
| fake timers, fetch + AbortController | no vm-specific difference | – | – |

## Risks of `shared` mode (`isolate: false`)

| risk | reproduced? | mitigation | residual |
|---|---|---|---|
| **`vi.mock` of a project module imported transitively** (test → component → `api/client`) | **yes, both ways**. A cached importer keeps the first binding it saw (real or mocked). Even identical `vi.mock` calls conflict, because each file creates its own `vi.fn()` instances and the cached component calls the first file's. Full heavy suite: **308–311 failed tests** in 35 files with `vi.mock` | **`resetModules: true` is the default**, giving the same 5 failures as forks at −97 % CPU. With `resetModules: false` the planner adds hard edges: a file mocking M ↔ every file that imports M un-mocked or reaches it through another project module (heavy: 780 edges, 39 files to forks) | with `resetModules: false`, only the static import graph |
| `vi.mock` of a module imported directly, `vi.doMock`, `vi.spyOn` | no | – | – |
| module-level state in `src` | yes | `resetModules` (default) or planner soft edges + history | – |
| node_modules singletons (i18next init, react-query online/focus managers) | yes | probes via `vi.importActual`. query-core is reset; i18next becomes a hard edge to its importers. Auto-detection of CJS export state | packages without a probe whose state is not visible in exports: caught only by self-healing |
| `vi.mock('package')` from node_modules | yes | static edge: mocking file ↔ importers of the package | – |
| manual global assignment (`Date.now = vi.fn()`), `vi.stubGlobal`/`stubEnv`, fake timers left on, DOM / `<head>` leftovers, window/document listeners, storage, React roots never unmounted | yes | resets: snapshot of ~40 watched globals, `unstubAll*`, `useRealTimers`, DOM cleanup (library-owned `<head>` nodes such as emotion's are left alone), removal of non-library listeners, `storage.clear()`, unmount in `act()` | assignments to other globals are only reported by `scan` |
| tampered `expect` / matchers / `vi` | yes (F12 test) | integrity check fails the file | see Security |

### Planner (shared)

1. **Conflict graph**. Hard edges come from:
   - history (`conflicts.json`, written by hunt);
   - `vi.mock('package')` vs the package's importers;
   - different factories for the same module;
   - transitive-mock edges (only when `resetModules` is off);
   - singleton pollution that survived the resets.

   Soft edges come from shared stateful modules. Modules per test file come from vto `fileload.modules`
   (`--vto-raw`), or else from the static import graph.
2. **Partition**: greedy colouring (LPT by duration from `durations.json` or vto `durationMs`) into `--lanes`
   lanes per project. A hard edge never shares a lane; a soft edge costs 25 % of the ideal lane load. Files that
   fit nowhere go to an isolated bucket (forks).
3. **Order within a lane**: known victims first, polluters last.
4. **How it maps onto Vitest 5.1.1** (verified in `groupSpecs` / `pool.run`):
   - with `isolate:false` + `maxWorkers:1`, a project's files go in **one run request to one worker**, in
     sequencer order;
   - with more workers, a worker is reused only for the same project and only if the next queued task matches,
     and files are picked dynamically;
   - several projects with `maxWorkers:1` need different `groupOrder` values and then run serially.

   So `vitest-guard run` starts **one Vitest process per lane** (`VITEST_GUARD_LANE_FILE` with `{ project, files }`,
   `maxWorkers: 1`, `VitestGuardSequencer`), plus one process for the isolated bucket.
5. **Self-healing**: a file that fails shared but passes isolated is bisected against its predecessors in the same
   worker (~log2(n)+2 runs), and the pair is recorded.

## Measurements

### `mode: 'auto'` (the real-world suite and heavy, full suites, CPU s)

Lab copies; the real-world suite original was not touched. "current" = the repo's own config (the real-world suite:
projects `dom` + `node`, both vmThreads; heavy: Vitest default forks).

| repo | variant | CPU s | vs current | vs forks | failed tests |
|---|---|---|---|---|---|
| the real-world suite (1992 tests) | current (vmThreads + vmThreads) | 168.6 / 174.8 | – | −42 % | 0 |
| | forks (all isolated) | 297.1 | +73 % | – | 0 |
| | all vm (vitest-guard) | 178.3 | +4 % | −40 % | 1 (load timeout) |
| | all shared (vitest-guard) | 119.2 | −30 % | −60 % | 0 |
| | **auto, defaults** (dom → vm, node → shared) | **143.5** | **−15 %** | −52 % | 0 |
| | `calibrate` (one-time, 20 files per project) | 80.4 | | | |
| | **auto, calibrated** (`modes.json`: dom → shared, node → shared) | **114.3 / 120.5 / 112.1** | **−34 %** | **−62 %** | 0 (same as forks and current: none) |
| heavy (3193 tests) | current (forks) | 480 / 498 | – | – | 5 (pre-existing) |
| | **auto, defaults** (all 312 files classified dom → vm) | **74.4** | −85 % | −85 % | 5 |
| | `calibrate` | 44.6 | | | |
| | **auto, calibrated** (dom → shared) | **17.6 / 17.1** | **−96 %** | −96 % | 5: identical failing-test list to forks (diffed) |
| | first `vitest-guard check` (auto-calibrates, then checks in auto mode) | 67.2 | | | 5, the 3 pre-existing files |

Reading: on both repos the best mode per group turned out to be `shared`, so a calibrated `auto` equals the best
single mode (all shared) within noise. It does not beat it here. The uncalibrated defaults already beat the
repo's own setup on the real-world suite (−15 %), because the node project leaves vmThreads (+9–10 % vs forks there).
`auto` pays off when the groups differ (DOM-heavy UI suites next to CPU-heavy pure logic) and as a safe default
that `calibrate` refines. Calibration is sample-based: when it picks `shared`, confirm with
`verify --mode shared --sample all` (nightly) before relying on it.


CPU time (user+sys of the process tree). The 2-core box was shared with other agents (load 3–8), so wall time is
unreliable.

**Full heavy suite** (312 files / 3193 tests). Every row with 5 failures has the **identical** failing-test list as
forks.

| variant | CPU s | vs forks | failed tests |
|---|---|---|---|
| forks | 480 / 498 | – | 5 |
| vmThreads bare | 64.6 / 64.3 | −87 % | 5 |
| **vitest-guard (vm)** | **67.2 / 65.6** | **−86 %** | **5** (overhead +2.0…+4.0 %) |
| threads + isolate:false bare | 29.8 / 29.3 | – | **308–311** |
| vitest-guard shared without `resetModules` | 31.9 | – | **308** |
| **vitest-guard shared (default)** | **16.1 / 16.1** | **−96.7 %** | **5** |
| `vitest-guard run` (planned, no diag) | 18.0 / 18.1 | −96.3 % | 5 |
| `vitest-guard run --no-reset-modules` (39 files to forks) | 83.9 | −83 % | 5 |

**Heavy subset** (39 files / 390 tests, medians, interleaved): forks 67.3. vmThreads 11.56 → vitest-guard 11.80 (+2.1 %
paired median, −82.5 % vs forks). Bare shared 5.15 → vitest-guard shared 5.33 (+3.5 %).

**Layer self-time** (wall, so an upper bound): vm 2.8–3.8 ms per file, shared 6–8 ms per file, 17 ms per file with
diagnostics.

**Shared fixture** (48 files, 17 polluter/victim pairs): worst order without vitest-guard has 12 victims failing. The
resets leave 2 (i18next, `src` state). The planner with self-healing reaches 0 from the second run on.

**the real-world suite** (projects `dom` + `node`, 1992 tests): plain 171.7 s CPU, guarded 181.5 s. The +5.7 % is within
noise under load 8 — on the two slowest files, repeated: plain 43.5/43.3 s, guarded 45.4/43.4 s, without realm
shims 43.6/43.2 s. Under heavy load a guarded run hit 5 extra 5-second timeouts in CPU-bound simulation tests. All
of them pass with a longer timeout; they are load-induced.

## What vitest-guard does not cover

- **False greens vs forks**: the shims make vm more tolerant than forks + jsdom (jsdom has its own realm in forks).
  Only `verify` catches this, hence a nightly forks run.
- `constructor ===` / prototype checks and `Object.prototype.toString` tricks in user code.
- require hooks, `require.cache`, `process.chdir`, anything using `Module._load`: quarantine only.
- vm: `process` listeners, patched builtins and singletons stored on `process` are reported, not restored.
- shared: state inside node_modules closures without a probe that is not visible in exports (`resetModules` resets
  project modules only). Only self-healing catches it, after a first failing run.
- shared with `resetModules: false`: mock edges come only from the static import graph (no dynamic imports or
  aliases).
- The node_modules state detector cannot tell parser scratch state from a leak. `stylis` is ignored by default;
  add others to `ignoreModules`.
- **Not a security boundary** (see Security).

## Recommended rollout

0. `node <path-to-vto>/vitest-guard/bin/vitest-guard.mjs compare --sample all` to pick the mode per project (vm for DOM projects, shared or forks for
   pure-node ones).
1. `VITEST_GUARD_MODE=vm node <path-to-vto>/vitest-guard/bin/vitest-guard.mjs verify --sample all` locally; review false greens and false reds.
2. `node <path-to-vto>/vitest-guard/bin/vitest-guard.mjs check --mode vm` and commit `.vitest-guard/incompatible.json`.
3. PR pipeline: plain `vitest run` with `defineVitestGuardConfig` (vm + quarantine in forks). Exit 4 from `check` on a
   PR means someone added a vm-incompatible test.
4. Nightly: `VITEST_GUARD_MODE=isolated vitest run` (whole suite isolated), plus `node <path-to-vto>/vitest-guard/bin/vitest-guard.mjs verify --sample 500`
   (exit 5 = false green), plus `node <path-to-vto>/vitest-guard/bin/vitest-guard.mjs check --prune`. Security gates always run isolated.
5. Shared mode for local and pre-push runs: `node <path-to-vto>/vitest-guard/bin/vitest-guard.mjs scan`, then `node <path-to-vto>/vitest-guard/bin/vitest-guard.mjs run`. Promote it to CI once a
   nightly `verify --mode shared --sample all` has stayed clean for a while.

**Per project**: run `vitest-guard compare --sample all` once. jsdom/happy-dom projects usually gain most in vm;
pure-node projects often gain nothing or get slower (the real-world suite `node`: +9.0 %), so use `shared` (with
`resetModules`) or keep `forks` there. With `projects`, set the pool per project, and vitest-guard keeps it.

**Starting point**: `mode: 'auto'` (dom → vm, node → shared), then `vitest-guard calibrate` and a clean nightly
`verify --mode shared --sample all` before trusting a calibrated `shared`.

**Recommendation**: `vm` as the CI default (isolation of the module graph by design, ~2–4 % overhead, −86 %).
`shared` (with the default `resetModules`) is 4× faster than vm on the full suite (−97 %), but its correctness
rests on resets and heuristics. Without `resetModules` it was unsafe (308 failures that only showed up on the full
suite), so it stays opt-in until verify has been clean for a while.

## Lab and tests

Reproductions, fixtures and scripts are in `/home/claude/vmguard-lab` (`repro/*`, `shared/`, `mem/`, `heavy/`,
`fort/`). Tests: `npm test` (`test/unit.test.mjs`, `test/security.test.mjs`). It needs `vitest` installed;
without it the integration tests are skipped.
