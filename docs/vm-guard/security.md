# Security

## vm-guard is not a sandbox

`vmThreads` and `isolate: false` share the process, Node builtins and `process`; shared mode also shares the
module registry and the realm. Test code or a dependency can tamper with `expect`, matchers, `vi`, `node:*` or
vm-guard's own state for later files in the same worker, and those files then pass whatever they assert.

- Run security-critical gates (authorisation, crypto, audit tests) in `isolated` mode
  (`VM_GUARD_MODE=isolated`: forks with isolation), not in the fast run.
- Shared mode has a cheap integrity check (identity of `expect`, ~30 core matchers, `vi.*`, a few intrinsics),
  compared at every file start; a mismatch fails the file. The worker store is a non-writable, non-configurable
  property of `process` whose contents are still mutable. This guards against accidents and naive tampering, not
  against a test that is written to defeat it.
- Do not run untrusted test code with vm-guard to contain it. It does not contain anything.

## What vm-guard writes and where

| path | written by | committed | content |
|---|---|---|---|
| `.vm-guard/incompatible.json` | `check`, `verify`, `scan --quarantine` | yes | quarantine entries |
| `.vm-guard/conflicts.json` | `check`, `hunt` | yes | conflict edges |
| `.vm-guard/durations.json`, `pollution.json` | CLI runs | only with `--commit-state` | timings, pollution kinds |
| `.vm-guard/run/**` | setup file and CLI | no (own `.gitignore` with `*`) | logs, plan, caches, verify/compare records, `modes.json`, `auto.json`, `env.json`, `env-*.jsonl`, lane files |
| `node_modules/.vm-guard/*.mjs` | `defineVmGuardConfig` for symlinked installs | no | identical copies of setup files (atomic write; skipped if the directory is a symlink) |
| private temp dir (`mkdtemp`, 0700) | CLI | no | Vitest JSON reports, removed afterwards |

Nothing is sent over the network. vm-guard does not modify your source files or `package.json`.

## Validation of committed data

`.vm-guard/*.json` are repository data and therefore untrusted (a PR can change them). Only entries that are
literal, normalised, repo-relative paths of existing files inside the repository (no `..`, absolute paths, glob
metacharacters, or symlinks pointing outside), that match the project's `include`, match none of its `exclude`
globs, and that Vitest itself lists, reach `include`, plans or hunts. Others are ignored with a warning. The same
filter applies to `VM_GUARD_LANE_FILE`, `conflicts.json`, `pollution.json`, `durations.json` and `hunt --before`.
The `env.json` reader accepts only well-formed entries with safe path keys.

Temp files: reports are read without following symlinks, and only if the directory and file belong to the current
user, the directory is 0700 and the file has one link.

Recommendation: protect `.vm-guard/incompatible.json` and `conflicts.json` with CODEOWNERS; quarantine entries
decide which tests run in the weaker mode, so a PR that quarantines a security test deserves review. Regression
tests for these cases: `vm-guard/test/security.test.mjs`.

## Supply chain

The package has no runtime dependencies; it requires your project's Vitest (peer). It is not on npm: install from a
reviewed commit. The unrelated npm package `vm-guard` must never be executed in its place.
