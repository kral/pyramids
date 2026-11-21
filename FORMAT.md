# vto raw data format 2.2 (collector → analyzer, daemon, verify)

The collector records, for every test, which blocks of project code it executed. This document describes those
records as they are written today (`meta.formatVersion: "2.2"`, `meta.version: 2`). The machine-checkable form is
[contracts/raw-2.schema.json](contracts/raw-2.schema.json) (raw records) and
[contracts/map-2.schema.json](contracts/map-2.schema.json) (stored map). Cross-component decisions referenced as
D1–D5 are in [contracts/DECISIONS.md](contracts/DECISIONS.md). Earlier versions: see [History](#history).

## Files

A run writes newline-delimited JSON into the raw directory (`$VTO_RAW_DIR`, `run-raw.mjs <rawDir>`):

| file | written by | content |
|---|---|---|
| `w-<runId>-meta.jsonl` | runner (`collector/run-raw.mjs`) | one `meta` record |
| `w-<runId>-<pid>-<threadId>.jsonl` | each Vitest worker (`collector/setup-v2.mjs`) | `file`, `fileload`, `test` records |
| `.vto-raw`, `.gitignore` (`*`) | runner | marker of a vto raw dir |

`runId` is random per run, so shards and repeated runs into one directory (`--no-clean`) never collide. vto deletes
only directories that carry the marker, and inside them only its own `w-*.jsonl` / `s-*.jsonl` files. Readers take
`w-*.jsonl` and `s-*.jsonl` files recursively (the daemon store uses `map/s-*.jsonl` and `map/t/s-*.jsonl`), skip
symlinked files, and read an explicitly named file whatever its name.

## Compatibility rules

- `meta.version` is the major version. A reader refuses a higher value than it implements.
- `meta.formatVersion` (`"2.1"`, `"2.2"`) is informative. Every 2.x addition is optional for readers: a missing
  field makes the reader more conservative (select more, or run all), never less.
- Readers ignore unknown fields and unknown record kinds (`t`). Writers emit only fields the schema lists.

## Paths and hashes

- Every path (`file.file`, `test.file`, `test.hits` keys, `fileload.testFile`, `fileload.hits` keys,
  `fileload.modules`, `fileload.loadMs` keys, `fileload.reads`, `meta.testFiles`, `meta.setupFiles`,
  `meta.dirtyFiles`) is **relative to `meta.root`**, with `/` separators. Files outside the root (monorepo siblings)
  stay absolute.
- `meta.root` is the canonical spelling of the project root (realpath, `/` separators, Windows `C:/x/y`, Unicode
  NFC). Path comparison follows D2: case-insensitive where the file system is (`meta.caseInsensitive`).
- `sha256` fields hold the **content hash of D1**: SHA-256 of the file bytes after removing one leading UTF-8 BOM
  and replacing `CRLF` by `LF`. A checkout with CRLF and BOM therefore hashes like the LF checkout.

## Records

### `meta` – once per run

```jsonc
{"t":"meta","version":2,"formatVersion":"2.2","engine":"v2","runId":"…","startedAt":"2026-11-21T20:00:00Z",
 "root":"/abs/project","vitest":"5.1.1","projects":[null],
 "gitHead":"<40/64-hex>"|null,"dirty":false|true|null,"dirtyFiles":[{"path":"src/a.ts","sha256":"…"|null}],
 "testFiles":["test/a.test.ts"],"setupFiles":["test/setup.ts"],"caseInsensitive":false}
```

| field | meaning |
|---|---|
| `gitHead` | commit the map was recorded at (`null`: not a git repository) |
| `dirty` | the working tree had uncommitted or untracked changes (`null`: not a git repository) |
| `dirtyFiles` | when `dirty`: every path of `git status --porcelain=v1 -z --untracked-files=all`, with its D1 hash at record time (`null` = deleted). A bare string is allowed for files that have a `file` record with `sha256` |
| `testFiles` | every test file Vitest collected, including files whose tests were all skipped or that failed to load |
| `setupFiles` | the user's setup files (vto's own excluded) |
| `projects` | Vitest project names in the run (`null` = the root project) |
| `producer` | optional, e.g. `"vto-daemon"` |

### `file` – block table of an instrumented module

```jsonc
{"t":"file","file":"src/Button.tsx","sha256":"…","blocks":[[3,0,9,1,"f"],[5,4,5,30,"b"],[7,2,8,3,"s"]]}
```

- `blocks[i]` = `[startLine, startCol, endLine, endCol, kind]`; lines 1-based, columns 0-based, positions in the
  **original** source (no source maps needed). The array index is the block id.
- `kind`: `f` function body, `b` branch or statement block (if/else, switch case, loop body, catch/finally,
  `a ? b : c` arms, the right operand of `&&` / `||` / `??`, default parameter values), `s` continuation after a
  compound statement that can complete abruptly (`return` / `throw`, or `break` / `continue` leaving it).
- `sha256`: D1 hash of the source the instrumenter read from disk. A file already changed by an earlier plugin is
  not instrumented.
- Written once per module per worker, by the worker that evaluated it, before any record that references it.
  Modules without blocks (constants, re-exports) are registered too. Workers must agree on the table.
- `hash` (16 hex) is deprecated: writers stop emitting it, readers ignore it.

### `test` – one per test

```jsonc
{"t":"test","file":"src/Button.test.tsx","name":"Button > renders label","line":12,"state":"pass",
 "durationMs":3.2,"assertions":2,"hits":{"src/Button.tsx":[0,1,4,7]}}
```

| field | meaning |
|---|---|
| `name`, `line` | full name (describe chain joined by ` > `) and the test's line (`includeTaskLocation: true`; never null in v2) |
| `state` | `pass`, `fail`, `skip`, `todo`. Tests skipped at collection (`.skip`, `.todo`, `skipIf`, `runIf`) get a record without hits |
| `hits` | sorted block ids executed between the first per-test reset and the end of the test's hooks |
| `durationMs` | from vto's first `beforeEach` to after all `afterEach` / cleanup (hooks included) |
| `assertions` | `expect.getState().assertionCalls` |
| `tainted`, `leaky` | coverage overlapped another test / late hits arrived after the test ended (async work) |
| `retryCount`, `assertHash`, `domHash` | optional; equal fingerprints strengthen the "same coverage" tier of the report |

Unit identity in every tool: `relpath:line > full name`.

### `fileload` – once per test file per worker

```jsonc
{"t":"fileload","testFile":"src/Button.test.tsx",
 "hits":{"src/Button.tsx":[0,3]},
 "modules":["src/Button.tsx","src/theme.json"],"loadMs":{"src/Button.tsx":1.7},
 "reads":["src/__fixtures__","test/__snapshots__/Button.test.tsx.snap"],"readsComplete":true}
```

| field | meaning |
|---|---|
| `hits` | blocks executed outside any test: import time, suite `beforeAll` / `afterAll`, after the last test |
| `modules` | every module evaluated for this test file (the module registry at `afterAll`); may include non-instrumented files of the Vite module graph (JSON, CSS, SVG, `?raw`). Entries are paths or `{"file", "loadMs"}` |
| `loadMs` | a module's own evaluation time, exclusive of its static imports (Vite hoists them above the prelude); a module evaluated by an earlier test file of the same worker (`isolate: false`) keeps its first value |
| `reads` | files and directories the test file touched through `node:fs` (read, stat, readdir, open, streams, copy, glob, readlink, realpath, watch; sync, callback and promise forms), from collection through the last hook. Paths probed but missing are included; `node_modules` and paths outside the root are dropped. Includes Vitest's own reads such as snapshot files. Entries are paths or `{"path"}`; `""` / `"."` is the root |
| `readsComplete` | `true`: every fs entry point was wrapped and the file started no child process or worker. `false`: something escaped. Absent: unknown |
| `error` | the test file failed to load or a file-level hook threw: coverage incomplete |

Several `fileload` records for one test file (shards, retries, shared workers) are unioned.

## How the collector produces hits

A Vite plugin (`collector/plugin.mjs`, `enforce: 'pre'`) instruments project source files only (not
`node_modules`, test files or virtual modules). It parses TS/TSX/JS/JSX with oxc-parser and inserts markers with
magic-string: `__vto_k[i]=1` on a module-local `Uint8Array` registered in `globalThis.__vto_reg`, expression
positions wrapped as `(__vto_k[i]=1, expr)`. A source that already contains `__vto` gets a random prefix instead
(`__vto_x<8 hex>_k`), so the markers cannot collide with user identifiers. A `vto-ignore-file` pragma leaves a module untouched and registers
it with an empty block table.

Per test, vto's `beforeEach` zeroes every registered array and its `afterEach` collects the non-zero indices: the
cost is proportional to the number of project blocks, with no inspector. Hits between two tests of the same suite
mark the previous test `leaky`; late work that lands inside the next test cannot be told apart from it.

## Stored map (`vto pack`)

`vto pack <rawDir> --out map.jsonl --root <repo root>` writes the single portable form of a map: the same record
kinds in one file, first record `{"t":"meta","version":2,"stored":true,"pathBase":"root",…}`. Every path is
relative to the root given at pack time (pass the repository root), block columns are `0` and kinds `b`, import-time
hits are stored once and `test.hits` is always present. Every vto command accepts a stored map in place of a raw
directory.

## Reading rules (analyzer, daemon)

Validation. Any failure makes `vto affected` answer "run all" (exit 3): an unsupported version, an invalid record,
a block table with invalid lines (start 0, end before start, beyond 10 M lines) or different between workers, hits
on unknown files or block ids, several `gitHead` values, and inputs over the limits (`--max-raw-bytes`,
`--max-line-bytes`, `--max-records`).

Selection follows D5. In short:

- The diff is always *map commit → working tree*. A map commit the clone does not have means run all. A dirty map
  is usable only with `meta.dirtyFiles`. A file whose working-tree hash differs from its recorded `sha256` counts
  as changed even when git reports nothing.
- A changed line strictly inside a block selects the tests that hit the block. Any other line also holds top-level
  code and selects every test file that loads the module (`fileload.modules`, or any hit in it).
- A change at or below a `fileload.reads` entry selects that test file. A test file with `readsComplete: false`,
  or without `reads` whose source imports `fs`, is selected for every change.
- A changed, new or renamed test file is selected by its current path. A new file that is not a test file means
  run all (directory scans such as `import.meta.glob` can pick it up without a recorded edge).
- Test files with a recorded failure, `fileload.error`, no `fileload`, or no test record are always selected. Test
  files with `skip` / `todo`, `tainted` or `leaky` tests are selected as a whole when anything they load changed.
- Selection is per test file by default: coverage of one test can depend on earlier tests of the same file through
  module-level state. `--test-granularity` selects single tests (opt-in, not recall-safe for such code).
- Ignore rules are gitignore-like (last match wins, `!` re-includes) and never beat the map: an ignored path is
  skipped only when the map knows nothing about it. Defaults: `*.md`, `docs/**`, `.vitest-guard/**`,
  `!.vitest-guard/incompatible.json`, `!.vitest-guard/conflicts.json`.

`--vitest` output: a JSON array of `./path` filters, one per selected test file (`file:line` only with
`--test-granularity`). Run all = `null`, nothing selected = `[]`. With `--print0`: NUL-separated filters, run all =
the single filter `.`, nothing selected = no output. Treat exit 3, and any other non-zero exit, as run all:
`vto affected … --vitest --print0 | xargs -0 -r npx vitest run`.

Overlap report: units with a `fail`, `skip`, `todo`, `tainted` or `leaky` test are excluded from every verdict and
listed with the reason. Identical-coverage groups whose tests sit on one source line (`it.each`) get the tier
`parametric`: coverage is blind to data. "Unnecessary imports" sums `loadMs` over test files that load a module
without using it.

## Map provenance

The analyzer trusts the map. Record maps only in trusted jobs (main or protected branches), key caches by commit
SHA, vto version and config hash, never restore a cache written by a pull request into a trusted job, and keep the
full suite on the merge queue or main. Test selection speeds feedback up; it is not a security gate.

## History

| version | change |
|---|---|
| 1 (`--engine v8`) | V8 precise coverage per test (`test.cov`, `script` records with the transformed source, absolute `file://` URLs). Opt-in fallback only: it serialises coverage of the whole isolate on every test (tens of ms per test) and stores source text |
| 2 | own instrumentation: `file` block tables in original positions, `test.hits`, absolute paths |
| 2 addendum A | `fileload` (`hits`, `modules`, `loadMs`), `skip` / `tainted` / `leaky`, fingerprints |
| 2.1 | `meta` record per run with `root`; paths root-relative; `file.hash`; raw dir marker; `fileload.reads` |
| 2 addendum B | `meta.version`, `gitHead`, `dirty`; `file.sha256`; stored map (`vto pack`); validation limits |
| 2.2 | D1 content hash for every `sha256` (`file.hash` deprecated); `fileload.readsComplete`, `fileload.error`; `meta.dirtyFiles`, `meta.testFiles`, `meta.caseInsensitive`; collection-time `skip` / `todo` records |

A sample raw directory (format 2.1, two test files) is in `samples/demo-raw/`.
