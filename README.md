# vitest-guard

Makes Vitest's fast pools safe to use: `vmThreads` and shared workers (`isolate: false`) with realm isolation,
a quarantine for files that are not compatible, and a check that a fast run is not falsely green.

```sh
npm i -D @jirikral/vitest-guard@next
```

- Package README: [vitest-guard/README.md](vitest-guard/README.md) ([česky](vitest-guard/README.cs.md))
- Documentation: [docs/vitest-guard/](docs/vitest-guard/index.md)

Status: **alpha**, published on npm under the dist-tag `next`. Linux, macOS and Windows are tested in CI
(Node `^22.22.2 || >=24.15.0`, Vitest 4.1 or 5.1).

Licence: MIT OR Apache-2.0.
