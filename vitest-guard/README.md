# vitest-guard

> **Install (pre-release, dist-tag `next`):** `npm i -D @jirikral/vitest-guard@next` (pnpm: `pnpm add -D @jirikral/vitest-guard@next`,
> yarn: `yarn add -D @jirikral/vitest-guard@next`). Run the CLI through your project's own install: add the script
> `"guard": "vitest-guard"` to `package.json` and call `npm run guard -- check`, or
> `node node_modules/@jirikral/vitest-guard/bin/vitest-guard.mjs check`.
>
> **Never run `npx vitest-guard`:** the unscoped name `vitest-guard` is not ours, and whoever owns it would run their code on your machine.
>
> Unreleased changes: `npm pack` in a checkout of the repository's `vitest-guard/` directory, then
> `npm i -D ./jirikral-vitest-guard-<version>.tgz` (a real copy, no symlink).


*Czech version: [README.cs.md](README.cs.md).*

vitest-guard makes the two fast Vitest modes safe to switch on (supported Vitest `>=4.1 <6`; 4.1 and 5.1 are tested in CI; timings below: Vitest 5.1.1):

| mode | Vitest | heavy suite, 312 files / 3193 tests, CPU s |
|---|---|---|
| `isolated` (Vitest default) | `pool: 'forks'`, `isolate: true` | 480–498 |
| **`vm`** | `pool: 'vmThreads'` | **66 (−86 %)**, layer overhead +2–4 % |
| **`shared`** | `pool: 'threads'`, `isolate: false` + per-file `resetModules` | **16.1 (−97 %)** |

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
limitations): [docs/vitest-guard/index.md](https://github.com/kral/vto/blob/main/docs/vitest-guard/index.md).

> **Removed in 0.2.0-alpha.0:** mode `auto` and `calibrate`, the shared-mode planner (`plan`, `run`, `--lanes` planning,
> `durations.json`, `pollution.json`), `scan`, `report`, the animated swan and every vto integration. They live on the
> [`vto` branch](https://github.com/kral/vto/tree/vto) (paused). Removed commands and options exit with 2 and say so.

## Quick start

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { defineVitestGuardConfig } from '@jirikral/vitest-guard';

export default defineVitestGuardConfig(
  defineConfig({ plugins: [react()], test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'] } }),
  { mode: 'vm' }, // or 'shared'
);
```

`defineVitestGuardConfig`:
- puts `@jirikral/vitest-guard/setup` **first** in `setupFiles` (one bundled module; every setup module costs a fetch and an
  evaluation per test file in vm pools);
- sets the pool. `vm` → `vmThreads` plus a sane `vmMemoryLimit`. `shared` → `threads` + `isolate:false`;
- quarantine: files in `.vitest-guard/incompatible.json` (for the mode) run in a sibling `forks` project. Without a
  quarantine no `projects` are created, because a single inline project costs ~4 % CPU;
- `server.deps.inline`: only what you pass in `inline`. No package in the lab needed inlining. Warns when only
  one of react / react-dom is inlined;
- warns about `test.poolOptions` (removed in Vitest 4 and silently ignored).

Switches (bash syntax; PowerShell: `$env:VITEST_GUARD_MODE='vm'`, cmd: `set VITEST_GUARD_MODE=vm`): `VITEST_GUARD_MODE=vm|shared|isolated|off`, `VITEST_GUARD_OPTS='{"realm":false}'` (JSON options),
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
`<project>:isolated` sibling in `forks` holds just that project's quarantined files. Projects given as a path or glob (`'packages/*'`), or as functions, are not
wrapped; vitest-guard prints a warning (wrap those configs themselves). A config exported as a function: call it and
pass the object. Validated on the `the real-world suite` repo (projects `dom` + `node`, both vmThreads).

### Options (`defineVitestGuardConfig(config, options)`)

| option | default | meaning |
|---|---|---|
| `mode` | `'vm'` | `'vm'` / `'shared'` (for projects without an explicit pool) / `'isolated'` / `'off'` |
| `memoryLimit` | `autoMemoryLimit()` | overrides `vmMemoryLimit` |
| `inline` | `[]` | extra `server.deps.inline` |
| `onDirty` | `'warn'` | dirty state at file start: `'warn'` / `'error'` / `'silent'` |
| `react` | `true` | duplicate React = error. `'warn'` = warning, `false` = off |
| `realm` | `true` | vm: `Symbol.hasInstance` shims, realm equality tester, missing Web globals |
| `restoreEnv` / `reset` | `true` | restore `process.env` / shared-mode resets |
| `resetModules` | `true` | shared: `vi.resetModules()` after every file. **Required for `vi.mock` correctness** |
| `integrity` | `true` | shared: integrity check of `expect` / matchers / `vi` at file start (see Security) |
| `diag` | CLI only | pollution diff at file end, residual after reset, node_modules export-state scan (costs CPU) |
| `setup` | `'file'` | `'import'`: your first setup file starts with `import '@jirikral/vitest-guard/setup'` (one module less per file) |
| `alwaysProjects` | `false` | create `projects` even without a quarantine |
| `sharedPool` | `'threads'` | `'forks'` for shared mode |
| `ignoreModules` | `['stylis/…']` | node_modules paths whose exports hold parser scratch state (not reported as leaks) |

## CLI

```
npm run guard -- check  [--mode vm|shared] [--prune] [filters…]
npm run guard -- verify [--mode vm|shared] [--sample N|all] [--seed s] [--orders gate,forward,reversed,shuffle]
npm run guard -- compare [--sample N|all] [--project a,b]
npm run guard -- hunt   <file> [--before a,b,c]
```

- **check**: runs the suite in the fast mode and re-runs failing files isolated in `forks`, comparing **per test**.
  A test that passes isolated but fails fast puts its file into `.vitest-guard/incompatible.json` with a normalised
  error signature. A file that fails only after other files is bisected for the polluter (hunt) and quarantined with the
  files it fails after (shared mode also records the pair in `.vitest-guard/conflicts.json`). Before quarantining, the file is re-run once in the fast mode. If it passes, it is reported as FLAKY (typically
  timeouts under load) and not quarantined (`--no-confirm` skips this). `--prune`
  releases quarantined files that pass in the fast mode again.
- **verify**: runs a sample both fast and isolated and compares every test. A *false green* (passes fast, fails
  isolated) exits with 5. Real example: the realm shims make vm more tolerant than forks + jsdom.
- **hunt**: bisects the files that ran before the victim in the same worker (order from the run log).
- **compare** (also `check --compare`): per project, runs a sample (`--sample N`, default 30; use `--sample all`
  for decisions) in forks, vm and shared, measures the CPU time of the whole Vitest process tree, counts tests whose
  result differs from forks, and recommends a mode per project: the fastest mode without mismatches, or forks when
  it saves less than 10 %. Results go to `.vitest-guard/run/compare.json`.

Exit codes (docs/vitest-guard/cli.md#exit-codes): `0` ok, `1` test failures (genuine, flaky or unexplained), `2` usage or config
error (e.g. config not wrapped), `4` quarantine/conflict state changed (commit `.vitest-guard/incompatible.json` /
`conflicts.json` and re-run), `5` false green in `verify`. `vitest-guard --help` and `vitest-guard <command> --help` list every option.

Files:
- **commit** only `.vitest-guard/incompatible.json` and `.vitest-guard/conflicts.json` (protect them with CODEOWNERS). They
  are rewritten only when their content changes.
- everything volatile lives in `.vitest-guard/run/` and is **git-ignored automatically** (vitest-guard writes
  `.vitest-guard/run/.gitignore` containing `*`): run logs (`run/logs/`), lane files, `verify-*.json` and `compare.json`.
  Files that older versions wrote into `.vitest-guard/` (`durations.json`, `pollution.json`, `plan.json`, `modes.json`,
  `env.json`, ...) are no longer used: delete them.

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
- **Data in `.vitest-guard/`** is validated (F9). Only these entries reach `include` and hunts: literal,
  normalised, repo-relative paths of existing files inside the repository (no `..`, absolute paths, glob
  metacharacters or symlinks pointing outside) that match the project's `include`, match none of its `exclude`
  globs, and that Vitest itself lists. Anything else is ignored with a warning. The same applies to
  `VITEST_GUARD_LANE_FILE`, `conflicts.json` and `hunt --before`.
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
| **`vi.mock` of a project module imported transitively** (test → component → `api/client`) | **yes, both ways**. A cached importer keeps the first binding it saw (real or mocked). Even identical `vi.mock` calls conflict, because each file creates its own `vi.fn()` instances and the cached component calls the first file's. Full heavy suite: **308–311 failed tests** in 35 files with `vi.mock` | **`resetModules: true` is the default**, giving the same 5 failures as forks at −97 % CPU. With `resetModules: false` it stays broken: do not turn it off | – |
| `vi.mock` of a module imported directly, `vi.doMock`, `vi.spyOn` | no | – | – |
| module-level state in `src` | yes | `resetModules` (default) | – |
| node_modules singletons (i18next init, react-query online/focus managers) | yes | probes via `vi.importActual`. query-core is reset; i18next becomes a hard edge to its importers. Auto-detection of CJS export state | packages without a probe whose state is not visible in exports: caught only by self-healing |
| `vi.mock('package')` from node_modules | yes | `resetModules` re-evaluates the importers | – |
| manual global assignment (`Date.now = vi.fn()`), `vi.stubGlobal`/`stubEnv`, fake timers left on, DOM / `<head>` leftovers, window/document listeners, storage, React roots never unmounted | yes | resets: snapshot of ~40 watched globals, `unstubAll*`, `useRealTimers`, DOM cleanup (library-owned `<head>` nodes such as emotion's are left alone), removal of non-library listeners, `storage.clear()`, unmount in `act()` | assignments to other globals are caught by the end-of-file pollution diff of `check` |
| tampered `expect` / matchers / `vi` | yes (F12 test) | integrity check fails the file | see Security |

## Measurements

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

**Heavy subset** (39 files / 390 tests, medians, interleaved): forks 67.3. vmThreads 11.56 → vitest-guard 11.80 (+2.1 %
paired median, −82.5 % vs forks). Bare shared 5.15 → vitest-guard shared 5.33 (+3.5 %).

**Layer self-time** (wall, so an upper bound): vm 2.8–3.8 ms per file, shared 6–8 ms per file, 17 ms per file with
diagnostics.

**Shared fixture** (48 files, 17 polluter/victim pairs): worst order without vitest-guard has 12 victims failing. The
resets leave 2 (i18next, `src` state). `check` quarantines the remaining victims, which brings it to 0 from the second run on.

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

(`npm run guard --` assumes this script in your `package.json`; or call
`node node_modules/@jirikral/vitest-guard/bin/vitest-guard.mjs` directly instead.)

```json
{ "scripts": { "guard": "vitest-guard" } }
```

0. `npm run guard -- compare --sample all` to pick the mode per project (vm for DOM projects, shared or forks for
   pure-node ones).
1. `npm run guard -- verify --mode vm --sample all` locally; review false greens and false reds.
2. `npm run guard -- check --mode vm` and commit `.vitest-guard/incompatible.json`.
3. PR pipeline: plain `vitest run` with `defineVitestGuardConfig` (vm + quarantine in forks). Exit 4 from `check` on a
   PR means someone added a vm-incompatible test.
4. Nightly: `VITEST_GUARD_MODE=isolated vitest run` (PowerShell: `$env:VITEST_GUARD_MODE='isolated'; npx vitest run`; cmd: `set VITEST_GUARD_MODE=isolated && npx vitest run`) (whole suite isolated), plus `npm run guard -- verify --sample 500`
   (exit 5 = false green), plus `npm run guard -- check --prune`. Security gates always run isolated.
5. Shared mode for local and pre-push runs: `npm run guard -- check --mode shared`. Promote it to CI once a
   nightly `verify --mode shared --sample all` has stayed clean for a while.

**Per project**: run `vitest-guard compare --sample all` once. jsdom/happy-dom projects usually gain most in vm;
pure-node projects often gain nothing or get slower (the real-world suite `node`: +9.0 %), so use `shared` (with
`resetModules`) or keep `forks` there. With `projects`, set the pool per project, and vitest-guard keeps it.

**Recommendation**: `vm` as the CI default (isolation of the module graph by design, ~2–4 % overhead, −86 %).
`shared` (with the default `resetModules`) is 4× faster than vm on the full suite (−97 %), but its correctness
rests on resets and heuristics. Without `resetModules` it was unsafe (308 failures that only showed up on the full
suite), so it stays opt-in until verify has been clean for a while.

## Lab and tests

Tests: `npm test` in this directory (`node --test test/*.test.mjs`; install the dev dependencies with `npm ci`;
without Vitest the integration tests fail unless `VITEST_GUARD_TEST_NO_INTEGRATION=1`).
