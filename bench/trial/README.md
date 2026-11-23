# bench/trial

`package.json` + `package-lock.json` of the generated benchmark project (`bench/gen-project.mjs` writes the sources,
not the manifest). The `vitest-guard-trial` workflow generates a project, copies these two files next to it, runs
`npm ci` (the `vitest` matrix axis installs Vitest 4.1.8 over the lockfile's 5.1.1 for the 4.1 legs, together with the tarball) and drives `.github/scripts/vg-trial.mjs` on Linux, macOS and Windows.
