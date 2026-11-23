# Troubleshooting and FAQ

First step for any strange result: run the same files with `VITEST_GUARD_MODE=isolated` (reference) and, to rule out
vitest-guard completely, `VITEST_GUARD_MODE=off` (your untouched config).

The `VAR=value command` form is bash/zsh. PowerShell: `$env:VITEST_GUARD_MODE='isolated'; npx vitest run` (the variable stays
set for that session until `Remove-Item Env:VITEST_GUARD_MODE`); cmd: `set VITEST_GUARD_MODE=isolated && npx vitest run`.

| symptom | cause | what to do |
|---|---|---|
| `vitest-guard check` exits 2: "<config> is not wrapped with defineVitestGuardConfig" | the config the CLI loads does not go through `defineVitestGuardConfig`, so `VITEST_GUARD_MODE` would have no effect | wrap it, or pass `--config vitest.guard.config.ts`. Nothing is run or written in this case |
| exits 2 "vitest is not installed in <root>" | vitest-guard uses the project's own Vitest (>=5.1 <6) | `npm i -D vitest@^5.1` in the project; check `--root` |
| `defineVitestGuardConfig needs a plain config object` | config is a function or promise | resolve it first: `defineConfig(async (env) => defineVitestGuardConfig(await base(env)))` |
| `x instanceof Array/Error/Map` false, `toStrictEqual` fails only in vm | objects from Node builtins or copied globals belong to the outer realm | the shims cover constructors listed in [how-it-works.md](how-it-works.md); user code such as `x.constructor === Array` is not covered: fix the code, or quarantine (`check` does it) |
| MSW fails at import in vm | missing Web globals (streams, `BroadcastChannel`, ...) | vitest-guard copies them (`realm: true`, default). If you set `realm: false`, undo it. MSW + happy-dom also fails in forks (measured) |
| memory keeps growing / worker recycled often | outer-realm leaks accumulate in vm; `vmMemoryLimit` recycles the worker | `report` shows the leakiest files; raise `memoryLimit` (default: min of 50 % RAM per worker and 60 % V8 heap limit, at least 512 MB). A 300 MB limit gave 7 recycles and +44 % CPU in the lab |
| "FLAKY" in `check`, exit 1 | the file failed fast, passed in forks and passed again on a fast retry with the same predecessors | genuinely flaky (timeouts under load are typical); fix or re-run. It is not quarantined |
| ORDER-DEPENDENT in `check`, exit 4 | the file passes alone but fails after specific earlier files in the same worker | the polluter is listed; fix the leak, or accept the quarantine (vm) / conflict edge (shared) |
| test is green in the fast mode but red in `VITEST_GUARD_MODE=isolated` | false green: state left by another file (or realm tolerance) | `vitest-guard verify --sample all`; it quarantines the file, whose real failure then shows in forks |
| `[vitest-guard] shared mode is not verified against isolated forks: ...` | no clean full `verify` for this commit and config/quarantine state | run `vitest-guard verify --mode shared --sample all` (this updates the record), or silence with `verifyWarning: false` / `VITEST_GUARD_VERIFY_WARNING=0` |
| `[vitest-guard] <file> starts with state left by <prev>` | the leak detector found state from the previous file | fix that file, add `ignoreListeners` / `ignoreModules` for known-harmless state, or set `onDirty: 'silent'` |
| `[vitest-guard] integrity: toBe replaced ...` | an earlier file in the shared worker replaced `expect`, a core matcher or `vi.*` | the file is re-run in forks by `check`; fix the polluter |
| `Duplicate React: ...` | two physical copies of `react` | `npm dedupe` / `resolve.dedupe: ['react','react-dom']`; `react: 'warn'` downgrades |
| `vi.mock` stops applying in shared mode | `resetModules: false` (or `--no-reset-modules`) | keep the default `true` |
| quarantine entries ignored with a warning | entry is not a literal, repo-relative path of an existing file Vitest lists | see [security.md](security.md); fix or delete the entry |
| `vitest run` exits 1: "... incompatible.json: ... The quarantine cannot be applied, so vitest-guard refuses to run" | the quarantine file is not JSON (a merge conflict), has the wrong shape, a newer format version, or is (or sits in) a symlink | fix the file by hand (`vitest-guard check` exits 2 with the same reason and never overwrites it). For a newer format during an upgrade: `VITEST_GUARD_NEWER_STATE=failsafe` runs the files it names isolated |
| "entry ... is spelled differently on disk (case or Unicode form): applied to ..." | the quarantine key differs from the file name in case or NFC/NFD form (Windows, macOS) | the file runs isolated anyway; `vitest-guard check` rewrites the key (exit 4), commit `.vitest-guard/incompatible.json` |
| `vitest run` exits 1: "tail: false is not supported in shared mode" | the shared-mode baseline is taken after the setup files, which the tail setup file marks | remove `tail: false` (or run that config in mode `vm` / `isolated`) |
| a file fails with "the tail setup file (setup-tail.mjs) did not run before ..." | the setup files vitest-guard adds were changed or reordered after `defineVitestGuardConfig` | keep vitest-guard's setup file first and `setup-tail.mjs` last, with `sequence.setupFiles: 'list'` |
| `check` prints "kept quarantine entry ... of config ..." or "kept in quarantine (entry of config ...)" | the entry was written by another guarded config in the same root (or is a version 1 entry for a file this config does not list) | nothing to do: that config's own `check --prune` releases it |
| `check` exits 1: "QUARANTINE NOT APPLIED" | the config does not run a quarantined file isolated (another `quarantineFile`, an unguarded project, a rejected entry) | read the `[vitest-guard] ignoring ...` lines printed below it; fix the entry or the config |
| `check` exits 1: "STALE quarantine entry ... guarded a false green" | the entry names a test file Vitest no longer lists (renamed, moved, deleted) | find where the test went; `check --prune` removes stale entries (exit 4) |
| `verify` exits 1: "ORDER MISMATCH" | a lane did not run in the requested order (custom sequencer, Vitest change) | the comparison proves nothing for that order; report it with the run logs in `.vitest-guard/run/logs/` |
| mode `auto` shows a group `auto:rest` | the catch-all project: test files Vitest globs that neither the dom nor the node group lists run there, isolated (forks) | usually empty; files in it were missed by the classification and still run |
| files from `.vitest-guard/` showing up in `git status` | older versions wrote volatile files there | the CLI moves them into `.vitest-guard/run/`; commit the removal |
| symlinked install: tests under jsdom cannot load vitest-guard's setup, or two copies of vitest | the package lives outside the project root | install from a tarball. vitest-guard copies its setup files to `node_modules/.vitest-guard/` and always resolves Vitest from the project root, but pnpm-style or workspace layouts were not exhaustively tested (unverified) |
| a PowerShell/cmd path problem running the CLI | | use `node node_modules\@jirikral\vitest-guard\bin\vitest-guard.mjs` or an npm script |
| `check` reports "UNEXPLAINED failure" | file failed in the fast run, passes in forks, but its group is isolated already or it is quarantined | read the failure in the fast run output (`--verbose`); usually the quarantine is stale: `check --prune` |

## Flaky or fast-mode-only?

`check` decides by experiment, not by guess:

1. failing files re-run in isolated forks; a file that fails there too is a genuine failure;
2. a file that passes in forks is re-run in the fast mode (up to `--retries`, default 2). Failing every time on its
   own: fast-mode-incompatible (quarantine). Passing: its recorded predecessors are replayed; failing again:
   order-dependent (quarantine with `after`, or a conflict edge in shared); passing again: flaky.

`--no-confirm` and `--no-hunt` weaken this and are documented as such in [cli.md](cli.md).

## FAQ

**Can I use `npx vitest-guard`?** No – never: the unscoped npm name is not ours (anyone could publish it). Use an npm script or
`node node_modules/@jirikral/vitest-guard/bin/vitest-guard.mjs`.

**Do I need the CLI at all?** Day to day, no: `vitest run` with the wrapped config is the fast mode and uses the
committed quarantine. The CLI creates and maintains that quarantine and checks for false greens.

**Which files do I commit?** `.vitest-guard/incompatible.json` and `.vitest-guard/conflicts.json` (plus `durations.json` /
`pollution.json` only with `--commit-state`).

**How do I turn it off temporarily?** `VITEST_GUARD_MODE=off` (not guarded at all) or `isolated` (Vitest default
isolation with the guard layer's logging). PowerShell: `$env:VITEST_GUARD_MODE='off'; npx vitest run`; cmd: `set VITEST_GUARD_MODE=off && npx vitest run`.

**Does it work with Vitest `projects`?** Yes, for inline project objects ([configuration.md](configuration.md)).

**Does vitest-guard work with Jest or Vitest 4?** No: Vitest `>=5.1 <6` is the supported range.
