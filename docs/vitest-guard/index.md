# vitest-guard documentation

vitest-guard makes Vitest's two fast execution modes safe enough to use as the default for a whole suite. This page is
the one-page overview; the other pages go deeper.

> Status: pre-release `0.1.0-alpha.3`, published on npm under the dist-tag `next`: `npm i -D @jirikral/vitest-guard@next`
> (pnpm: `pnpm add -D @jirikral/vitest-guard@next`, yarn: `yarn add -D @jirikral/vitest-guard@next`). Run the CLI through
> an npm script or `node node_modules/@jirikral/vitest-guard/bin/vitest-guard.mjs`. **Never run `npx vitest-guard`**: the
> unscoped name `vitest-guard` is not ours, and whoever owns it would run their code on your machine.

## The problem

Vitest runs every test file in a fresh environment by default (`pool: 'forks'`, `isolate: true`). That is correct
and slow: module graph, jsdom and your imports are rebuilt for every file. Two faster configurations exist:

| mode | what Vitest does | speed | what breaks |
|---|---|---|---|
| `vm` | `pool: 'vmThreads'`: one `vm` context per file inside a shared worker | large gain on DOM suites | objects from Node builtins come from another realm (`instanceof`, `toStrictEqual`), missing Web globals, memory growth, state in `process` |
| `shared` | `isolate: false` (threads): files run one after another in the same realm and module registry | largest gain | state leaks between files, and `vi.mock` stops applying to cached importers |

Used bare, these modes either fail tests that pass in forks (false red) or, worse, pass tests that fail in forks
(false green).

## How vitest-guard works (one page)

1. You wrap your Vitest config: `export default defineVitestGuardConfig(defineConfig({...}), { mode: 'vm' })`.
   vitest-guard sets the pool, puts one bundled setup file first, and routes quarantined test files to a sibling
   `forks` project.
2. The setup file runs per test file. In `vm` mode it installs realm shims (so `instanceof Array` works across
   realms) and copies missing Web globals. In `shared` mode it snapshots the worker's global state, resets it after
   every file (timers, env, globals, DOM, listeners, React roots, optionally the module registry), and reports
   anything that survives ("dirty start", naming the previous file).
3. The CLI is the safety net. `vitest-guard check` re-runs every failing file in isolated forks and explains the
   failure: genuine, fast-mode-only (quarantine it in `.vitest-guard/incompatible.json`), caused by another file
   (conflict edge in `.vitest-guard/conflicts.json`), or flaky. `vitest-guard verify` compares pass/fail per test between
   the fast mode (in several file orders) and isolated forks to catch false greens.
4. You commit the two small JSON files. Plain `vitest run` then gives you fast mode with the quarantined files (`incompatible.json`)
   in forks. Conflict edges (`conflicts.json`, shared mode) are applied only by the planner, i.e. by `vitest-guard run` and
   `check --mode shared`, not by plain `vitest run` ([getting-started.md](getting-started.md) step 5).
5. A periodic isolated run (`VITEST_GUARD_MODE=isolated vitest run`; PowerShell: `$env:VITEST_GUARD_MODE='isolated'; npx vitest run`) plus `verify` stays as the reference.

Mode `auto` splits the suite into a DOM group and a node group and picks the best mode for each, using
measurements (`vitest-guard calibrate`).

## When to use it

- A suite of hundreds of files whose CPU time is dominated by per-file setup (jsdom/happy-dom, heavy imports).
- You can afford a nightly isolated run and a one-time `compare`/`verify` pass.
- Vitest >= 5.1 and < 6, Node `^22.22.2 || >=24.15.0`.

## When not to use it

- Small suites (seconds): the gain is not worth the moving parts.
- Pure-node projects in `vm` mode: measured slower than forks on the real-world suite (+9.0 %). Use `shared` or
  keep forks there; see [modes.md](modes.md).
- Security-critical tests (authorisation, crypto, audit gates): run them isolated. vitest-guard is not a sandbox
  ([security.md](security.md)).
- Projects that cannot wrap their Vitest config (config exported as a function or promise must be resolved first).

## Link map

| page | read it when |
|---|---|
| [getting-started.md](getting-started.md) | installing, first `check` and `verify`, 10-minute walkthrough |
| [modes.md](modes.md) | choosing between vm, shared, auto, isolated, off; measured numbers |
| [cli.md](cli.md) | every command, flag and exit code |
| [configuration.md](configuration.md) | every option of `defineVitestGuardConfig`, env vars, projects |
| [how-it-works.md](how-it-works.md) | realm shims, setup layering, leak detector, state files, scheduler |
| [ci.md](ci.md) | GitHub Actions and Azure Pipelines examples |
| [troubleshooting.md](troubleshooting.md) | failures and FAQ |
| [security.md](security.md) | what it is not, what it writes, what is validated |
| [limitations.md](limitations.md) | what does not help, residual risks |

Package README: [vitest-guard/README.md](https://github.com/kral/pyramids/blob/main/vitest-guard/README.md) (measurements and risk tables in detail).
