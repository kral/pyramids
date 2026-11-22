# Getting started

Requirements: Node `^22.22.2 || >=24.15.0`, Vitest `>=5.1 <6` installed in your project (vitest-guard always uses the
project's own Vitest; `package.json` declares it as a peer dependency).

> `@jirikral/vitest-guard` is published on npm under the dist-tag `next` (pre-release). **Never run `npx vitest-guard`**: the unscoped name `vitest-guard` is not ours, and whoever owns it would run their code on your machine. Run the CLI through your project's install (below).

## 1. Install

```sh
npm i -D @jirikral/vitest-guard@next       # pnpm: pnpm add -D @jirikral/vitest-guard@next
                                           # yarn: yarn add -D @jirikral/vitest-guard@next
```

For CI pin the version (`npm i -D -E ...`) and commit the lockfile. Same command in bash and PowerShell.

For changes that are not released yet, install from a tarball packed in a vto checkout (a real copy inside
`node_modules`, no symlink; about 27 files):

```sh
# in the vto checkout
cd vitest-guard
npm pack                      # creates jirikral-vitest-guard-<version>.tgz
# in your project
cd /path/to/your-project
npm i -D /path/to/vto/vitest-guard/jirikral-vitest-guard-<version>.tgz
```

PowerShell:

```powershell
cd C:\src\vto\vitest-guard
npm pack
cd C:\src\your-project
npm i -D C:\src\vto\vitest-guard\jirikral-vitest-guard-<version>.tgz
```

From the repository directly (`npm i -D ../vto/vitest-guard`, `npm link`) creates a symlink. That works: vitest-guard
detects that its setup files live outside your project root and uses an identical copy in
`node_modules/.vitest-guard/` (Vite would otherwise refuse to serve them to jsdom tests). See
[troubleshooting.md](troubleshooting.md) for symlink problems. The tarball avoids them.

How to run the CLI (the package has `bin: vitest-guard`):

- as an npm script (recommended, works on all platforms): `"guard": "vitest-guard"` then `npm run guard -- check`;
- directly: `node node_modules/@jirikral/vitest-guard/bin/vitest-guard.mjs check` (macOS/Linux/PowerShell alike).

## 2. Wrap the config

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { defineVitestGuardConfig } from '@jirikral/vitest-guard';

export default defineVitestGuardConfig(
  defineConfig({ test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'] } }),
  { mode: 'vm' },
);
```

Rules: the argument must be a plain object (not a function or a promise; resolve those first); the CLI refuses a
config that is not wrapped (exit 2) because `VITEST_GUARD_MODE` would otherwise do nothing. If you want to keep the
original config for everyday use, create `vitest.guard.config.ts` and pass `--config vitest.guard.config.ts`.

## 3. Ten-minute walkthrough

Same on Windows PowerShell, macOS and Linux (only the shell differs). Replace `vitest-guard` by
`node node_modules/@jirikral/vitest-guard/bin/vitest-guard.mjs` if you have no npm script.

1. Choose the mode per project, measuring on the whole suite (minutes, CPU heavy):
   `npm run guard -- compare --sample all`. It prints forks vs vm vs shared per project and a recommendation, and
   writes `.vitest-guard/run/modes.json` (only mode `auto` reads it; unused with `mode: 'vm'`). While it measures, a small
   swan is drawn on an interactive terminal ([cli.md](cli.md#animated-swan-compare-calibration); `VTO_NO_ANIMATION=1` turns it
   off). Skip if you just want to try `vm`.
2. Check: `npm run guard -- check` (mode vm, or `--mode shared`). Failing files re-run in forks and are explained.
   Exit 0 = nothing failed; exit 4 = new quarantine entries were written; exit 1 = failures.
3. If exit 4: `git add .vitest-guard`, commit, and re-run `check` until it exits 0. (Only the files that exist are
   staged: `incompatible.json` and/or `conflicts.json`, plus `durations.json`/`pollution.json` with `--commit-state`;
   `.vitest-guard/run/` ignores itself. Do not name both files: `git add` fails when one of them was not created.)
4. Verify (catches false greens, the case `check` cannot see): `npm run guard -- verify --sample all`. Exit 5 =
   false green found (the file is quarantined automatically; its real failure now shows in forks: fix the test).
5. Run normally: `npx vitest run` (or `npm test`) now uses the fast mode, with quarantined files in forks.
   (`npx vitest` is your own installed Vitest here, which is fine.) In **shared** mode this is not enough:
   `conflicts.json` (files that must not share a worker) is applied only by the planner, i.e. by
   `npm run guard -- run` (and `check --mode shared`); plain `vitest run` does not separate conflicting files. Use
   `npm run guard -- run` locally and keep `vm` for a gate that is plain `vitest run`. `verify --mode shared` can still
   report a false red in order `gate` for a recorded pair; see [cli.md](cli.md#verify) for how to converge.
6. Reference run: PowerShell `$env:VITEST_GUARD_MODE='isolated'; npx vitest run`; cmd `set VITEST_GUARD_MODE=isolated && npx vitest run`; bash `VITEST_GUARD_MODE=isolated npx vitest run`.
   Use it nightly ([ci.md](ci.md)).

Commit only `.vitest-guard/incompatible.json` and `.vitest-guard/conflicts.json` (whichever exist). Everything under `.vitest-guard/run/` is
volatile and git-ignored by vitest-guard itself (it writes `.vitest-guard/run/.gitignore`).

## 4. Try `auto`

```ts
export default defineVitestGuardConfig(defineConfig({ /* ... */ }), { mode: 'auto' });
```

The first `check` calibrates (20 files per group) and writes `.vitest-guard/run/modes.json`. Confirm a calibrated
`shared` with `verify --mode shared --sample all` before trusting it ([modes.md](modes.md)).
