# vto – raw data contract (collector → analyzer)

Collector (`collector/setup.ts`, a Vitest setupFile) writes newline-delimited JSON into
`$VTO_RAW_DIR/w-<pid>-<threadId>.jsonl`, one file per worker. Two record kinds:

```jsonc
// Transformed script source exactly as V8 saw it (Debugger.getScriptSource).
// Emitted once per url per worker file (the same url may appear in several worker files –
// sources should be identical; analyzer may dedupe by url and warn on mismatch).
{"t":"script","url":"file:///abs/src/price.ts","source":"'use strict';async (__vite_ssr_exports__,...)=>{{...\n//# sourceMappingURL=data:application/json;base64,...\n//# <vitest metadata comment>\n}}"}

// One record per finished test.
{"t":"test",
 "file":"/abs/test/price.test.ts",          // test file path
 "name":"price > basic",                     // full name, describe chain joined by " > "
 "line":4,                                   // test location line (may be null)
 "state":"pass"|"fail",
 "cov":[ {"url":"file:///abs/src/price.ts",
          "functions":[ [[start,end,count], ...], ... ] } ]}   // V8 precise coverage, raw
```

`cov` contains only project scripts (no node_modules, no test files, no collector itself) that
had at least one range with count > 0 during that test. Counts cover only the test body and
user hooks of that test (counters are reset in beforeEach, collected in afterEach).

## V8 range semantics
`functions[i][0]` is the function's own range; following ranges are nested blocks whose count
overrides the parent. Ranges of different functions nest too (inner functions are separate
entries). Effective count at byte offset = count of the innermost (smallest) range containing
it; offsets outside every range have count 0. Offsets are UTF-16 code unit indices into `source`.

## Source mapping
`source` = Vitest wrapper prefix on the first line (`'use strict';async (...)=>{`) + Vite SSR
transformed code + inline `//# sourceMappingURL=data:application/json;base64,...` (map relative
to the transformed code, whose line 0 starts after the wrapper prefix — only column offsets of
line 0 are shifted; line 0 is Vite helper code anyway). Covered segments that do not map to an
original position should be dropped (Vite-injected helpers, export getters).

Sample: `samples/demo-raw/` (from `samples/src`, `samples/test`; 7 tests).
Expected: basic / basic again / duplicate-of-basic have identical coverage; vip bulk,
throws on zero, formats have unique coverage; bulk discount is covered by the union of others
but not contained in any single test.

---

# v2 (PRIMARY) – own instrumentation instead of V8 profiler

Reason: Profiler.takePreciseCoverage serializes coverage of the WHOLE isolate (React, react-dom,
jsdom, testing-library…) on every test → tens of ms per test. v2 instruments only project files.

## Collector side
A Vite plugin (`enforce: 'pre'`, applied only to project source files: not node_modules, not
test files, not virtual modules) parses TS/TSX with `oxc-parser` (native, fast, Windows
prebuilt) and inserts hit markers with `magic-string`:
- one block per function body, statement-level block, if/else branch, switch case, loop body,
  catch/finally, conditional `a ? b : c` arms, logical `&&` / `||` / `??` right operand
  (important for JSX `{cond && <X/>}`), default param values, optional chaining is not needed.
- marker = `__vto_<fileIdx>[<i>]=1` (a module-local `Uint8Array` registered in
  `globalThis.__vto_reg[file] = arr`), expression positions wrapped as `(__vto_k[i]=1, expr)`.
- block positions are ORIGINAL source positions (recorded at instrument time) → no source maps
  needed for the analysis.
Per test: beforeEach → `arr.fill(0)` for every registered file; afterEach → collect indices of
non-zero entries. Cost O(total project blocks), microseconds; no inspector.

## Raw records (`$VTO_RAW_DIR/w-*.jsonl`)
```jsonc
{"t":"file","file":"/abs/src/Button.tsx",
 "blocks":[[startLine,startCol,endLine,endCol,"s"|"b"|"f"], ...]}  // 1-based lines, 0-based cols; index = block id
{"t":"test","file":"/abs/src/Button.test.tsx","name":"Button > renders label","line":12,
 "state":"pass"|"fail","durationMs":3.2,"assertions":2,
 "hits":{"/abs/src/Button.tsx":[0,1,4,7]}}   // sorted block ids hit during the test
```
A "file" record is emitted once per file per worker (identical across workers; analyzer dedupes
and warns on mismatch). Atoms for analysis = (file, block id). Line for reporting = startLine.
Analyzer may keep v1 (V8) support as a fallback mode, but v2 is the primary path.

## v2 addendum A (analyzer ↔ collector, agreed after REVIEW-1)
Additional records / fields. All optional for the analyzer – it degrades safely when missing.

```jsonc
// Once per test file per worker (emit in afterAll; several records for the same testFile – e.g. shards,
// retries of the file, isolate:false – are unioned by the analyzer).
{"t":"fileload","testFile":"/abs/src/Button.test.tsx",
 "hits":{"/abs/src/Button.tsx":[0,3]},     // blocks non-zero BEFORE the first per-test reset of this file:
                                           // import-time code + beforeAll hooks
 "modules":["/abs/src/Button.tsx","/abs/src/theme.json"]}  // every module evaluated for this test file
                                           // (registry keys at afterAll; MAY also contain non-instrumented
                                           // files from the Vite module graph – json/css/svg/?raw)
// Optional meta (once per worker file):
{"t":"meta","gitHead":"<sha>","setupFiles":["/abs/vitest.setup.ts"]}
```
Optional `test` fields: `"state":"pass"|"fail"|"skip"`, `"tainted":true` (overlapped with another
test), `"leaky":true` (late hits arrived after the test ended), `"retryCount":n`,
`"assertHash":"…"`, `"domHash":"…"` (fingerprints; equal values strengthen the "same coverage" tier).
`line` should never be null (run with `includeTaskLocation: true`).

Analyzer semantics:
- unit = (test file, full name, line); id = `relpath:line > full name`.
- failed / skipped / tainted / leaky units are excluded from every verdict and listed separately
  (report.json `excluded[].reason` and `tests[].excluded` are the codes `failed|skipped|tainted|leaky`;
  report.md is English by default, `--lang cs` / `VTO_LANG=cs` renders the Czech texts).
- `affected`: a changed line maps to ALL blocks overlapping it (default); a change outside every block,
  or in a block hit at import time (`fileload.hits`), selects every test of every test file whose
  `modules` contains the file. Without any `fileload` record such a change ⇒ exit 3 (run all).

Collector notes (v2, as implemented in `collector/`):
- Raw file names: `w-<runId>-<pid>-<threadId>.jsonl` (+ `w-<runId>-meta.jsonl`); `runId` is random per
  run, so shards / repeated runs into one dir (`run-raw.mjs --no-clean`) never collide.
- `file` records are written by the worker that executed the module (block table embedded in the
  instrumented module), always before the `test`/`fileload` records that reference them; modules
  with zero blocks (constants, re-exports) are registered too and appear in `fileload.modules`.
- `fileload.hits` = import-time hits + hits between tests that cross a suite boundary (suite
  `beforeAll`/`afterAll`) + hits after the last test (file `afterAll`). Hits between two tests of the
  same suite mark the previous test `leaky` (late async work); late work that lands *inside* the next
  test cannot be told apart from it.
- `durationMs` = our first beforeEach → after all afterEach/cleanup (includes hooks); `assertions` =
  `expect.getState().assertionCalls` of the test.
- `fileload.modules` entries may be plain paths or `{"file": path, "loadMs": 1.7}`; alternatively a
  separate `"loadMs": {path: ms}` map. Used to rank the "Unnecessary imports" section (cs: "Zbytečné importy"; Σ loadMs over loading test files).
- `fileload.loadMs` (optional, object `{path: ms}` parallel to the `modules` string array): the
  module's own evaluation time, measured from the instrumentation prelude to the end of the module.
  Vite SSR hoists imports above the prelude, so this is EXCLUSIVE time (child imports not included;
  dynamic `import()` inside top-level code is included). Modules evaluated by an earlier test file in
  the same worker (`isolate: false`) keep their first value.

## v2.1 (current collector output)
Additive to v2/addendum A; a reader that sees `meta.formatVersion == "2.1"` applies these rules.
- **Meta** (one `w-<runId>-meta.jsonl` per run, written by the runner):
  `{"t":"meta","formatVersion":"2.1","engine":"v2","gitHead":"<sha>|null","vitest":"5.1.1","runId":"…",
  "root":"/abs/project/root","setupFiles":["test/setup.ts"],"projects":[null|"name",…],"startedAt":"ISO"}`.
  `root` uses `/` separators (Windows: `C:/x/y`); `setupFiles` are the user's setup files (vto's own excluded).
- **Paths** in `file.file`, `test.file`, `test.hits` keys, `fileload.testFile`, `fileload.hits` keys,
  `fileload.modules`, `fileload.loadMs` keys are **relative to `meta.root`** with `/` separators. Files
  outside the root (monorepo siblings) stay absolute. Comparison against the root is case-insensitive on Windows.
- **`file.hash`**: first 16 hex chars of SHA-1 of the source text the instrumenter saw (= the file on disk;
  files changed by an earlier plugin are not instrumented). Lets `affected` detect a stale map per file.
- **Raw dir**: contains `.vto-raw` (marker) and `.gitignore` (`*`). vto deletes only marker dirs and only its
  own `w-*.jsonl` / `s-*.jsonl` files; readers should ignore other files.
- v1 (`--engine v8`) keeps absolute `file://` URLs and stores the transformed source of every covered file
  (`script` records) – it is opt-in for that reason; v2 never stores source text or environment values.

## v2 addendum B – integrity, provenance, stored map (after SECURITY-REVIEW)
Raw side (collector):
- `meta` record: `"version": 2` (raw format version; the analyzer refuses newer versions),
  `"gitHead": "<40/64-hex sha>"` (commit the map was recorded at), optional `"dirty": true` when the
  working tree had uncommitted changes. `vto affected` refuses (exit 3, run all) when the map has no
  gitHead, was recorded at a commit other than the diff base, or on a dirty tree – unless
  `--allow-stale`. `--expect-commit SHA` pins the expected commit explicitly.
- `file` record: optional `"sha256": "<hex>"` = SHA-256 of the ORIGINAL source bytes as read from
  disk at instrumentation time. `affected --git` compares it with the base-side blob of every changed
  file; a mismatch ⇒ that file is treated as stale (every test file loading it is selected).
Stored map (`vto pack <raw> --out map.jsonl --root <repo root>`): the same record kinds in one file,
first record `{"t":"meta","version":2,"stored":true,"pathBase":"root","gitHead":…,"dirty":…}`,
all paths relative to the root given at pack time (pass the repository root), block kinds collapsed
to `"b"`, import-time hits stored once. Any vto command accepts a stored map instead of a raw dir.

Validation in the analyzer (any failure in `affected` ⇒ run all, exit 3): unsupported version,
invalid records, block tables with invalid line ranges (start 0, end < start, > 10 M lines), block
tables differing between workers, hits on unknown files / block ids, several gitHead values, a changed
file that is in the map but loaded by no test file and hit by no test. Input limits: total raw size,
record size, record count (`--max-raw-bytes/--max-line-bytes/--max-records`). Symlinked raw files
are skipped.

Map provenance: the analyzer trusts the coverage map. Produce maps only in trusted jobs (main /
protected branches), key caches by commit SHA + vto version + config hash, never restore caches
written by PR jobs into trusted jobs, and keep the full suite on the merge queue / main – test
selection is an accelerator, not a security gate.
- **`fileload.reads`** (2.1, additive): sorted list of project-root-relative paths of files AND directories
  the test file touched through `node:fs` (sync, callback and `fs/promises` forms of `readFile`, `readdir`,
  `stat`, `lstat`, `opendir`, `access`, `exists`, `createReadStream`), from collection through the last
  hook. Non-existent paths probed by `existsSync`/`stat` are included (their creation matters too).
  `node_modules` and paths outside the root are dropped. Includes reads Vitest itself makes for the file
  (e.g. `__snapshots__/x.test.ts.snap`). Works in every pool (vm pools via Vitest's builtin re-sync).

## v2 addendum C – after VALIDATION-real-suite (analyzer side)
- `fileload.reads` (optional): array of paths – strings, or `{"path": p}` – that the test file read
  through `node:fs` (files and directories; root-relative like every 2.1 path). A change to a path equal
  to or below any entry selects every test of that test file; a changed file that is unknown to the
  module map but covered by `reads` no longer forces "run all". Until the collector records `reads`
  for a test file, the analyzer falls back to: test files whose source imports `fs` / `node:fs`
  (`/promises` too) are selected for **every** change.
- Modules without blocks (CSS modules, JSON, barrels) select their importers (`fileload.modules`)
  **and** their fs readers.
- Selection granularity: by default `affected` selects every test of a test file that has a selected
  test (coverage of one test can depend on earlier tests of the same file through module-level caches).
  `--test-granularity` restores per-test selection (opt-in, not recall-safe for such code).
- Ignore rules are ordered, gitignore-like (last match wins, `!pattern` re-includes). Defaults:
  `*.md`, `docs/**`, `.vm-guard/**`, `!.vm-guard/incompatible.json`, `!.vm-guard/conflicts.json`; the two
  re-included vm-guard files are "run all" triggers, the rest of `.vm-guard/` is volatile state.
- `--vitest` output: JSON array of `"./file:line"` filters; **run all = `null`**, nothing selected = `[]`.
  With `--print0`: NUL-separated filters; **run all = the single filter `.`** (matches every test file),
  nothing selected = no output. Use `vto affected … --vitest --print0 | xargs -0 -r npx vitest run` and
  still treat exit 3 (or any other non-zero exit) as "run all".
- report: identical-coverage groups whose tests all sit on one source line (`it.each`, generated
  rows) get the tier `parametric` and are listed last; the report notes that coverage is blind to data.
  "Unnecessary imports" sums `loadMs` only over test files that load a module without using it.
- Raw readers take only `w-*.jsonl` / `s-*.jsonl` files (recursively; the daemon's store uses
  `map/s-*.jsonl` and `map/t/s-*.jsonl`); an explicitly given file is read regardless of its name.
- Block kinds as instrumented: `s` (continuation) blocks are emitted only after a compound statement that
  can complete abruptly (`return`/`throw`, or `break`/`continue` leaving it); after any other statement the
  continuation always runs together with the enclosing block and would be a redundant atom.
