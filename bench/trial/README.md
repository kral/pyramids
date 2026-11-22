# bench/trial

`package.json` + `package-lock.json` of the generated benchmark project (`bench/gen-project.mjs` writes the sources,
not the manifest). The `vitest-guard-trial` workflow generates a project, copies these two files next to it, runs
`npm ci` and drives `.github/scripts/vg-trial.mjs` on Linux, macOS and Windows.
