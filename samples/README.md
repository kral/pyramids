# samples

A seven-test toy project and the raw coverage data recorded from it.

| path | what |
|---|---|
| `src/price.ts`, `test/*.test.ts` | the project under test |
| `demo-raw/` | raw data of one collection run (format 2.1, engine `v2`), see [`FORMAT.md`](../FORMAT.md) |

`demo-raw/` holds **no source code and no absolute paths**: block tables, per-test hit lists and
root-relative file names only (`meta.pathBase: "root"`, no `meta.root`). CI checks this
(`.github/scripts/check-repo.mjs`).

Try the analyzer on it (from the repository root, after `cargo build --release` in `analyzer/`):

```sh
analyzer/target/release/vto samples/demo-raw --out vto-sample-report
# vto [v2]: 7 tests (7 evaluated, 0 excluded), 10 items · identical: 1 groups · … · minimal set: 4/7
```

To regenerate: copy `src/` and `test/` into a scratch project that has Vitest installed, run
`node <vto>/collector/run-raw.mjs <rawDir>` there, then drop `root` from the `meta` record and add
`"pathBase":"root"` before copying the `w-*.jsonl` files here.
