# Getting started

Requirements: Node `^22.22.2 || >=24.15.0`, Vitest `>=5.1 <6` installed in your project (vm-guard always uses the
project's own Vitest; `package.json` declares it as a peer dependency).

> `@kral/vm-guard` is not published to npm. The unrelated npm package `vm-guard` must not be run: never type
> `npx vm-guard`. Every command below runs the local copy.

## 1. Install

Preferred: from a tarball (a real copy inside `node_modules`, no symlink).

```sh
# in the vto checkout
cd vm-guard
npm pack                      # creates kral-vm-guard-0.1.0.tgz (23 files)
# in your project
cd /path/to/your-project
npm i -D /path/to/vto/vm-guard/kral-vm-guard-0.1.0.tgz
```

PowerShell:

```powershell
cd C:\src\vto\vm-guard
npm pack
cd C:\src\your-project
npm i -D C:\src\vto\vm-guard\kral-vm-guard-0.1.0.tgz
```

From the repository directly (`npm i -D ../vto/vm-guard`, `npm link`) creates a symlink. That works: vm-guard
detects that its setup files live outside your project root and uses an identical copy in
`node_modules/.vm-guard/` (Vite would otherwise refuse to serve them to jsdom tests). See
[troubleshooting.md](troubleshooting.md) for symlink problems. The tarball avoids them.

How to run the CLI (the package has `bin: vm-guard`):

- as an npm script (recommended, works on all platforms): `"guard": "vm-guard"` then `npm run guard -- check`;
- directly: `node node_modules/@kral/vm-guard/bin/vm-guard.mjs check` (macOS/Linux/PowerShell alike).

## 2. Wrap the config

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { defineVmGuardConfig } from '@kral/vm-guard';

export default defineVmGuardConfig(
  defineConfig({ test: { environment: 'jsdom', setupFiles: ['./test/setup.ts'] } }),
  { mode: 'vm' },
);
```

Rules: the argument must be a plain object (not a function or a promise; resolve those first); the CLI refuses a
config that is not wrapped (exit 2) because `VM_GUARD_MODE` would otherwise do nothing. If you want to keep the
original config for everyday use, create `vitest.guard.config.ts` and pass `--config vitest.guard.config.ts`.

## 3. Ten-minute walkthrough

Same on Windows PowerShell, macOS and Linux (only the shell differs). Replace `vm-guard` by
`node node_modules/@kral/vm-guard/bin/vm-guard.mjs` if you have no npm script.

1. Choose the mode per project, measuring on the whole suite (minutes, CPU heavy):
   `npm run guard -- compare --sample all`. It prints forks vs vm vs shared per project and a recommendation, and
   writes `.vm-guard/run/modes.json`. Skip if you just want to try `vm`.
2. Check: `npm run guard -- check` (mode vm, or `--mode shared`). Failing files re-run in forks and are explained.
   Exit 0 = nothing failed; exit 4 = new quarantine entries were written; exit 1 = failures.
3. If exit 4: `git add .vm-guard/incompatible.json .vm-guard/conflicts.json`, commit, and re-run `check`
   until it exits 0.
4. Verify (catches false greens, the case `check` cannot see): `npm run guard -- verify --sample all`. Exit 5 =
   false green found (the file is quarantined automatically; its real failure now shows in forks: fix the test).
5. Run normally: `npx vitest run` (or `npm test`) now uses the fast mode, with quarantined files in forks.
   (`npx vitest` is your own installed Vitest here, which is fine.)
6. Reference run: PowerShell `$env:VM_GUARD_MODE='isolated'; npx vitest run`; bash `VM_GUARD_MODE=isolated npx vitest run`.
   Use it nightly ([ci.md](ci.md)).

Commit only `.vm-guard/incompatible.json` and `.vm-guard/conflicts.json`. Everything under `.vm-guard/run/` is
volatile and git-ignored by vm-guard itself (it writes `.vm-guard/run/.gitignore`).

## 4. Try `auto`

```ts
export default defineVmGuardConfig(defineConfig({ /* ... */ }), { mode: 'auto' });
```

The first `check` calibrates (20 files per group) and writes `.vm-guard/run/modes.json`. Confirm a calibrated
`shared` with `verify --mode shared --sample all` before trusting it ([modes.md](modes.md)).
