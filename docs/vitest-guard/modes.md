# Modes

`mode` selects how test files are executed. All numbers are CPU seconds (user+sys of the whole process tree)
from [`vitest-guard/README.md`](https://github.com/kral/vto/blob/main/vitest-guard/README.md), [`VALIDATION-real-suite.md`](https://github.com/kral/vto/blob/main/VALIDATION-real-suite.md) ("the real-world suite") and [`perf/RESULTS.md`](https://github.com/kral/vto/blob/main/perf/RESULTS.md) (the lab); both are files of the source repository, not part of the npm package.
They are measurements of those suites on a shared 2-core box, not promises for yours: measure with
`vitest-guard compare --sample all`.

| mode | Vitest configuration | source of the config value |
|---|---|---|
| `isolated` | `pool: 'forks'`, `isolate: true` (Vitest default) plus the guard layer's timing log | `mode: 'isolated'` or `VITEST_GUARD_MODE=isolated` (PowerShell: `$env:VITEST_GUARD_MODE='isolated'`) |
| `vm` | `pool: 'vmThreads'` + `vmMemoryLimit` | default |
| `shared` | `pool: 'threads'` (or `'forks'` with `sharedPool`), `isolate: false`, setup files in list order, `vi.resetModules()` after every file | `mode: 'shared'` |
| `auto` | generated `dom` and `node` projects (or your projects), each in its own mode | `mode: 'auto'` |
| `off` | your config is returned untouched | `VITEST_GUARD_MODE=off` only |

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
after each file and calls `vi.resetModules()` (default) so `vi.mock` applies again. The planner (`vitest-guard run`)
splits files into lanes (one Vitest process, one worker each) so files known to conflict never share a worker.

Measured:

| suite | forks | vitest-guard shared | failed tests |
|---|---|---|---|
| heavy lab suite | 480 / 498 | 16.1 / 16.1 (-96.7 %) | 5, identical list to forks |
| same, planned (`vitest-guard run`, no diag) | | 18.0 / 18.1 | 5 |
| same, `resetModules: false` | | 31.9 | 308 (`vi.mock` stops applying) |
| bare `isolate: false` | | 29.8 / 29.3 | 308-311 |
| the real-world suite, `dom` | 233.4 | 86.3 (-63.0 %) | 0 |
| the real-world suite, `node` | 59.7 | 25.4 (-57.4 %) | 0 |
| the real-world suite, total | 293.1 | 111.7 (-61.9 %) | 0; vs the repo's own bare vmThreads -32.9 % |

Risks: false greens (a test passes only because an earlier file left state: a prototype extension, a matcher, an
external singleton). Only `vitest-guard verify` compares against forks. Tampering with `expect` is detected by the
integrity check. Because of this, gate on `shared` only after a clean `verify --mode shared --sample all`
(the config prints a warning when a shared `vitest run` has no matching clean verify record).

## auto

How: with generated projects, files are routed by their configured environment into a `dom` group (jsdom/happy-dom)
and a `node` group. With your own `projects`, your split is kept and a mode is chosen per project from its
environment. Mode per group: `autoModes` option > `.vitest-guard/run/modes.json` (from `calibrate`, `compare`, or the
first `check`) > defaults (`dom` -> vm, `node` -> shared). A mode that is not vm/shared becomes `isolated`.
The files are listed with Vitest's own globber, so `./` patterns, symlinked directories and dot directories match
exactly as in Vitest. A third project, `auto:rest`, runs every file of your `include` that neither group lists in
isolated forks (usually none), so no test file is ever dropped.

Measured (the real-world suite, 1992 tests): forks 297.1; current repo setup 168.6 / 174.8; all vm 178.3; all shared
119.2; auto defaults 143.5; auto calibrated 114.3 / 120.5 / 112.1 (-34 % vs current, -62 % vs forks). Heavy lab suite:
auto defaults 74.4, auto calibrated 17.6 / 17.1 (5 failures, identical list to forks). In both, the calibrated result
equals "all shared" within noise: `auto` does not beat the best single mode there; it pays off when groups differ.

Options and opt-in `nodeEnvironment: 'node'` (moving DOM-free files of a DOM suite to a node-environment group,
with self-healing when it guesses wrong): [configuration.md](configuration.md), [how-it-works.md](how-it-works.md).

## Which mode should I use?

| situation | recommendation |
|---|---|
| jsdom/happy-dom suite, hundreds of files, want a low-risk first step | `vm` |
| pure-node project (no DOM) | `shared`, or keep forks; `vm` measured slower than forks (+9.0 %) |
| mixed repo (UI next to logic), want per-group choice | `auto`, then `vitest-guard calibrate` |
| fastest possible local/pre-push runs | `shared` + `vitest-guard run`; promote to CI after clean `verify --mode shared --sample all` |
| security-critical tests, or a test that needs `require.cache`, `process.chdir`, module hooks | `isolated` (quarantine does this per file) |
| debugging a suspected vitest-guard problem | `VITEST_GUARD_MODE=isolated` (reference) or `off` (not guarded at all) |
| decision is close (< 10 % gain) | stay on forks: `compare` itself recommends forks below 10 % |

Risk summary per mode:

| mode | main risk | safety net |
|---|---|---|
| vm | false reds (realm, process state), memory | `check` quarantines; `verify` for false greens (gate + reversed order; gate only on Vitest < 5) |
| shared | false greens, `vi.mock` behaviour, order dependence | resets, integrity check, `verify` (gate + forward + reversed), planner, nightly forks |
| auto | wrong group guess; calibration from a sample | self-healing (opt-in routing), `verify --sample all` |
| isolated | none beyond Vitest's | it is the reference |
| off | no guard | none |
