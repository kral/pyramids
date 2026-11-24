# Modes

`mode` selects how test files are executed. All numbers are CPU seconds (user+sys of the whole process tree)
from [`vitest-guard/README.md`](https://github.com/kral/vitest-guard/blob/main/vitest-guard/README.md), [`VALIDATION-real-suite.md`](https://github.com/kral/vitest-guard/blob/2e19ab7/VALIDATION-real-suite.md) ("the real-world suite") and [`perf/RESULTS.md`](https://github.com/kral/vitest-guard/blob/2e19ab7/perf/RESULTS.md) (the lab); these two files are in an earlier commit (`2e19ab7`) of the source repository, not part of the npm package.
They are measurements of those suites on a shared 2-core box, not promises for yours: measure with
`vitest-guard compare --sample all`.

| mode | Vitest configuration | source of the config value |
|---|---|---|
| `isolated` | `pool: 'forks'`, `isolate: true` (Vitest default) plus the guard layer's timing log | `mode: 'isolated'` or `VITEST_GUARD_MODE=isolated` (PowerShell: `$env:VITEST_GUARD_MODE='isolated'`) |
| `vm` | `pool: 'vmThreads'` + `vmMemoryLimit` | default |
| `shared` | `pool: 'threads'` (or `'forks'` with `sharedPool`), `isolate: false`, setup files in list order, `vi.resetModules()` after every file | `mode: 'shared'` |
| `off` | your config is returned untouched | `mode: 'off'` or `VITEST_GUARD_MODE=off` |

## vm

How: every test file gets its own `vm` context in a shared worker thread. node_modules code is re-evaluated in
the context, so library singletons are per file. Node builtins, `process`, native addons and globals copied from
Node (`structuredClone`, `fetch`/`Response`, `Buffer`, `AbortController`, `MessageChannel`) belong to the outer
realm and are shared. vitest-guard adds realm shims and copies missing Web globals ([how-it-works.md](how-it-works.md)).

Measured:

| suite | forks | vitest-guard vm | note |
|---|---|---|---|
| heavy lab suite, 312 files / 3193 tests | 480 / 498 | 67.2 / 65.6 (-86 %) | layer overhead +2.0 to +4.0 % over bare vmThreads (64.6 / 64.3) |
| the real-world suite, `dom` project | 233.4 | 108.5 (-53.5 %) | |
| the real-world suite, `node` project | 59.7 | 65.1 (**+9.0 %**) | slower than forks |
| the real-world suite, total | 293.1 | 173.6 (-40.8 %) | |

Risks: cross-realm `instanceof` residue (`x.constructor === Array`), outer-realm state not restored
(`process` listeners, patched builtins; `process.env` is restored), `require.cache` / `Module._load` hooks /
`process.chdir` (cannot be fixed: quarantine), memory growth until `vmMemoryLimit` recycles the worker.
Details: `vitest-guard/README.md` "Risks of vm mode".

## shared

How: files run sequentially in the same realm and module registry (`isolate: false`). vitest-guard resets global state
after each file and calls `vi.resetModules()` (default) so `vi.mock` applies again.

Measured:

| suite | forks | vitest-guard shared | failed tests |
|---|---|---|---|
| heavy lab suite | 480 / 498 | 16.1 / 16.1 (-96.7 %) | 5, identical list to forks |
| same, `resetModules: false` | | 31.9 | 308 (`vi.mock` stops applying) |
| bare `isolate: false` | | 29.8 / 29.3 | 308-311 |
| the real-world suite, `dom` | 233.4 | 86.3 (-63.0 %) | 0 |
| the real-world suite, `node` | 59.7 | 25.4 (-57.4 %) | 0 |
| the real-world suite, total | 293.1 | 111.7 (-61.9 %) | 0; vs the repo's own bare vmThreads -32.9 % |

Risks: false greens (a test passes only because an earlier file left state: a prototype extension, a matcher, an
external singleton). Only `vitest-guard verify` compares against forks. Tampering with `expect` is detected by the
integrity check. Because of this, gate on `shared` only after a clean `verify --mode shared --sample all`
(the config prints a warning when a shared `vitest run` has no matching clean verify record).

## Which mode should I use?

| situation | recommendation |
|---|---|
| jsdom/happy-dom suite, hundreds of files, want a low-risk first step | `vm` |
| pure-node project (no DOM) | `shared`, or keep forks; `vm` measured slower than forks (+9.0 %) |
| mixed repo (UI next to logic), want per-group choice | `projects` with a pool per project (the mode of each project follows its pool), then `vitest-guard compare` |
| fastest possible local/pre-push runs | `shared`; promote to CI after clean `verify --mode shared --sample all` |
| security-critical tests, or a test that needs `require.cache`, `process.chdir`, module hooks | `isolated` (quarantine does this per file) |
| debugging a suspected vitest-guard problem | `VITEST_GUARD_MODE=isolated` (reference) or `off` (not guarded at all) |
| decision is close (< 10 % gain) | stay on forks: `compare` itself recommends forks below 10 % |

Risk summary per mode:

| mode | main risk | safety net |
|---|---|---|
| vm | false reds (realm, process state), memory | `check` quarantines; `verify` for false greens (gate + reversed order; gate only on Vitest < 5) |
| shared | false greens, `vi.mock` behaviour, order dependence | resets, integrity check, `verify` (gate + forward + reversed), nightly forks |
| isolated | none beyond Vitest's | it is the reference |
| off | no guard | none |
