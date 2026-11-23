# Configuration

```ts
import { defineVitestGuardConfig } from '@jirikral/vitest-guard';
export default defineVitestGuardConfig(userConfig, options);
```

`userConfig` is a plain Vitest/Vite config object (not a function, not a promise; vitest-guard throws a message that
says how to resolve it first). The result is a config object; your own keys are kept. Types:
`node_modules/@jirikral/vitest-guard/src/index.d.ts` (`VitestGuardOptions`).

## What the function changes

- `test.setupFiles`: vitest-guard's bundled setup file first, then yours; shared mode appends a tail file (below).
- `test.pool` / `test.isolate`: set according to the mode. In a single-project config your own `pool`/`isolate`
  are removed (the mode decides). In `projects`, explicit project pools are kept ([Projects](#projects)).
- `test.include` / `test.exclude`: kept (defaults `**/*.{test,spec}.?(c|m)[jt]s?(x)` and `**/node_modules/**`,
  `**/.git/**`); quarantined files are excluded from the fast project and run in an `...:isolated` sibling.
- `test.maxWorkers`: filled with Vitest's run-mode default (CPUs - 1) if unset; 1 inside a planner lane.
- `test.vmMemoryLimit` (vm): `test.vmMemoryLimit` of yours, else `memoryLimit`, else `autoMemoryLimit`.
- `test.provide.vitestGuard`: the resolved options, read by the setup file.
- `test.server.deps.inline`: your entries plus `inline`.
- Warns about `test.poolOptions` (removed in Vitest 4, ignored) and about only one of react/react-dom inlined.
- Without quarantine and without `alwaysProjects`, no `projects` are created (a single inline project cost ~4 % CPU).

## Options

| option | type | default | meaning |
|---|---|---|---|
| `mode` | `'vm' \| 'shared' \| 'auto' \| 'isolated'` | `'vm'` | execution mode ([modes.md](modes.md)). `off` exists only as `VITEST_GUARD_MODE=off` |
| `autoModes` | `Record<string, 'vm'\|'shared'\|'isolated'>` | none | `auto`: mode per group (`dom`, `node`) or project name; beats `modes.json` |
| `respectPools` | boolean | `false` | `auto` with user projects: keep projects that set an explicit pool |
| `nodeEnvironment` | `'node' \| null` | `null` | `auto`: opt in to moving DOM-free files of a DOM-configured suite to a node-environment group |
| `memoryLimit` | number \| string | `autoMemoryLimit(maxWorkers)` | `vmMemoryLimit` for vm (bytes or Vitest string such as `'1.5GB'`) |
| `inline` | `(string\|RegExp)[]` | `[]` | extra `server.deps.inline` entries |
| `onDirty` | `'warn' \| 'error' \| 'silent'` | `'warn'` | what to do when a file starts with state left by the previous one |
| `react` | boolean \| `'warn'` | `true` | duplicate React copies: throw, warn, or off |
| `reactPackages` | string[] | `[]` | extra packages checked for their own `react` copy (added to a built-in list) |
| `realm` | boolean | `true` | vm: realm shims, equality tester, missing Web globals |
| `probes` | boolean | `true` | shared: singleton probes (i18next, TanStack Query core) |
| `restoreEnv` | boolean | `true` | restore `process.env` after each file |
| `reset` | boolean | `true` | shared: reset hooks between files |
| `resetModules` | boolean | `true` | shared: `vi.resetModules()` after each file. Required for `vi.mock` correctness |
| `integrity` | boolean | `true` | shared: integrity check of `expect`, core matchers, `vi`, a few intrinsics |
| `tail` | boolean | `true` | shared: tail setup file marking "all setup files done" (needs `setupFiles` order `list`, which vitest-guard sets unless you set `sequence.setupFiles: 'parallel'`) |
| `verifyWarning` | boolean | `true` | shared: warn when no clean `verify` exists for this commit/config |
| `log` | boolean | `true` | write per-worker run logs to `.vitest-guard/run/logs` |
| `diag` | boolean | on only under the CLI (`VITEST_GUARD_DIAG=1`) | pollution diff at file end, residual after reset, node_modules export scan (CPU cost) |
| `moduleState` | boolean | follows `diag` | node_modules export-state scan |
| `detectPollution` | boolean | follows `diag` | end-of-file pollution diff (feeds the planner) |
| `ignoreListeners` | string[] | `[]` | process event names whose added listeners are not reported |
| `ignoreModules` | string[] | `[]` (+ built-in stylis entries) | node_modules paths whose exports hold scratch state (also learned after 3 consecutive changes) |
| `sharedPool` | `'threads' \| 'forks'` | `'threads'` | pool used by shared mode |
| `alwaysProjects` | boolean | `false` | emit `test.projects` even without quarantine |
| `setup` | `'file' \| 'import'` | `'file'` | `'import'`: your first setup file must start with `import '@jirikral/vitest-guard/setup'` (one module less per file) |

Exported helpers: `autoMemoryLimit(maxWorkers)` (min of 50 % RAM / workers and 60 % of the V8 heap limit, at least
512 MB), `readQuarantine(root, mode, file?)`, `setupFileFor(root, file?)`, `SETUP_FILE`, `SETUP_TAIL_FILE`,
`DEFAULT_INCLUDE`, `DEFAULT_EXCLUDE`. Subpath exports: `@jirikral/vitest-guard/setup` (for `setup: 'import'`) and
`/envstore` (**internal**: the contract with vto, experimental, no stability guarantee before 1.0). The sequencer and
the realm shims are internal files, not exports.

The quarantine file is always `.vitest-guard/incompatible.json`: the CLI writes it and the config reads it. The former
`quarantineFile` option was removed in 0.1.0-alpha.3; setting it throws an error.

## Environment variables

| variable | effect |
|---|---|
| `VITEST_GUARD_MODE` | `vm`, `shared`, `isolated`, `auto` override the `mode` option (and, in projects, the pool of every project); `off` returns your config untouched |
| `VITEST_GUARD_OPTS` | JSON object merged over the options in the config (`'{"realm":false}'`); invalid JSON throws at config load |
| `VITEST_GUARD_DIAG` | `1` enables diagnostics, `0` disables (the CLI sets 1 for its runs, `--no-diag` sets 0) |
| `VITEST_GUARD_PROFILE` | any value: section timings are added to the run log |
| `VITEST_GUARD_IGNORE_QUARANTINE` | any non-empty value (even `0`): do not route quarantined files to forks |
| `VITEST_GUARD_VERIFY_WARNING` | `0` silences the shared-mode "not verified" warning |
| `VITEST_GUARD_NEWER_STATE` | `failsafe`: a newer-format `incompatible.json` does not stop the config; every test file it names runs isolated (for upgrades in progress) |
| `VITEST_GUARD_AUTO_VERBOSE` | any value: print the dom/node split when `auto` builds projects |
| `VITEST_GUARD_CLI`, `VITEST_GUARD_LANE_FILE`, `VITEST_GUARD_WRAP_MARKER` | internal, set by the CLI; do not set |

## Projects

Inline objects in `test.projects` are wrapped one by one and keep their own pool:

| project setting | resulting mode |
|---|---|
| `pool: 'vmThreads'` or `'vmForks'` | vm |
| `pool: 'threads'`/`'forks'` with `isolate: false` | shared |
| another explicit pool | left alone (isolated) |
| no pool | the `mode` option |

`VITEST_GUARD_MODE` (`isolated`/`vm`/`shared`) overrides all of them. vitest-guard's setup runs first in each project.
Quarantine is per project (`<name>:isolated` sibling). Projects given as strings/globs (`'packages/*'`) or
functions are not wrapped: a warning says to wrap those configs themselves. In `auto`, the mode of each project is
chosen from its environment; explicit pools are replaced unless `respectPools`.
