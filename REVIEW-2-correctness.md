# vto – independent review #2: correctness ("can it say you're fine when a test would fail?")

Date 2026-11-21. Reviewed: vto repo at `e6598d9` (analyzer binary `analyzer/target/release/vto` built 06:21, newer than
every file in `analyzer/src`). Vitest 5.1.1, Node 22.23, Linux, 2 shared cores.
Reviewer wrote none of the product. No product code was changed; nothing was committed.

**Answer: yes.** `vto affected` (CLI) and `vto-daemon run-affected` both returned a green result while a plain
`vitest run` of the same tree failed, in 8 (CLI) and 9 (daemon) of 15 small, realistic scenarios. vm-guard `shared`
mode stays green on tests that fail in forks, and `verify --sample all` does not see it. vm-guard `vm` mode and the
instrumenter held up well.

All experiments live in `/home/claude/review2-correctness/`:

| path | what |
|---|---|
| `lab/` + `raw-lab/` | 22-file node project (copy of `demo` plus scenario files), map recorded with `collector/run-raw.mjs` at commit `2eab83b` |
| `harness/aff.mjs` | per scenario: mutate → `vto affected --git HEAD --vitest` → run the printed filters → compare with a full `vitest run`. Output: `aff-results.json` |
| `lab-d/`, `vto-pristine/`, `harness/dmn.mjs` | same scenarios through `vto-daemon run-affected --json` (stateless engine, pristine `.vto` restored per scenario) |
| `harness/fuzz.mjs`, `fuzz/s{1,2,3}` | differential fuzz of the daemon map patching (finding N2) |
| `lab-vmg/`, `lab-vmg2/` | vm-guard shared / vm labs |
| `lab-sem/` | instrumentation semantics probes; collection-failure scenario |
| `lab-ver/` | overlap report + `verify` on same-coverage tests |

Re-run everything for `affected`: `node harness/aff.mjs $PWD/lab $PWD/raw-lab` (≈2 min), daemon:
`node harness/dmn.mjs $PWD/lab-d $PWD/vto-pristine`.

## Top findings

| # | sev | component | one line | proof |
|---|---|---|---|---|
| B1 | blocker | `affected --vitest` | a test **added to an existing test file** is never run: filters are `file:line` of the recorded tests | S4c: selected run exit 0, full run 1 failed |
| B2 | blocker | `affected`, daemon | default ignore (`*.md`, `docs/**`) wins over recorded `reads`/`modules` | S3, S3b, S10: 0 tests selected, exit 0 |
| B3 | blocker | collector + `affected` | `fileload.modules` is frozen at the first `beforeAll`; modules loaded later (`await import()`, `vi.resetModules()` + import, lazy routes) are not dependencies | S1, S1b |
| B4 | blocker | `affected` | a changed line shared by top-level code and a nested function selects only the callers of that function | S2 |
| M1 | major | collector `reads` | child processes, worker threads and fd / `FileHandle` reads are invisible | S6 (false green), S9 (4 of 6 guard tests missed) |
| M2 | major | `affected`, daemon | a rename is not treated as a new file; the daemon ignores new non-test files completely | S7, D7b |
| M3 | major | collector + `affected` | a test that failed during collection keeps its truncated coverage and is selected by it | `lab-sem` job test |
| M4 | major | daemon store | `reads` are dropped from the map; misses become permanent because the file version advances | D5, D3, D2 run twice |
| M5 | major | `affected --vitest` | tests that did not run at collection time (`runIf`/`skipIf`) can never be selected | S8b |
| M6 | major | vm-guard shared | order-dependent false greens: green in `vitest run`, 3 failures in forks, `verify --sample all` reports 0 | `lab-vmg` |
| M7 | major | vm-guard check | a deterministic vm-only failure is labelled FLAKY, exit 0, no quarantine | `lab-vmg2` |
| M8 | major | verify | "confirmed redundant" for a regression test that differs only by a minus sign | `lab-ver` |
| M9 | major | entrypoint | `vitest-overlap.mjs` does not start (`SyntaxError`) | any invocation |
| m1–m4 | minor | various | hidden git changes, `toString`-serialised functions, verify report gaps | below |

Result table of the scenario harness (CLI = `vto affected` + recommended `--vitest` filters; daemon = `run-affected`):

| scenario | failing test in the full run | CLI | daemon |
|---|---|---|---|
| S0 control: edit inside `price()` | `price > vip bulk` | caught | caught |
| S1 `src/config.ts` constant, module only loaded by `await import()` in the test | `lazy.test.ts` | **false green** | **false green** |
| S1b `src/page.ts` constant, loaded statically by one test, lazily by the app | `app.test.ts` | **false green** | **false green** |
| S2 `label: 'Name'` on a line that also holds `render: (r) => …` | `header.test.ts` | **false green** | **false green** |
| S3 `docs/api.md` read with `readFileSync` | `docs.test.ts` | **false green** (0 selected) | **false green** (0 ran) |
| S3b `README.md` imported with `?raw` | `help.test.ts` | **false green** (0 selected) | **false green** |
| S10 `docs/api.md` grows, `statSync` guard | `guards/size.test.ts` | **false green** | not run separately |
| S5 `legacy.cjs` loaded through `require()` | `uses-legacy.test.ts` | caught (CJS loader read recorded) | **false green** |
| S6 `src/lib.mjs` used by a spawned `bin/cli.mjs` | `cli.test.ts` | **false green** | **false green** |
| S7 `git mv src/disabled/extra.ts src/plugins/extra.ts` (dir scanned by `import.meta.glob`) | `registry.test.ts` | **false green** | **false green** |
| D7b new file `src/plugins/b.ts` | `registry.test.ts` | run all (safe) | **false green** (0 ran) |
| S8b test under `it.runIf(process.env.FULL)`, map recorded without `FULL` | `ci-only.test.ts` | **false green** | caught |
| S9 `Math.random` added, 6 guard tests | 6 tests | 2 of 6 selected (fd, FileHandle, shell, worker missed) | 5 of 6 (shell missed) |
| S4c failing test appended to `price.test.ts` | the new test | **false green** | caught |
| S4/S4b test file edited with a line shift | new / edited test | Vitest error `No test found in … in lines 4, 5` (red for the wrong reason, the changed test never runs) | caught |
| S25 test file renamed + edited | `pages.test.ts` | Vitest error `Couldn't find file test/page.test.ts` | caught |

---

## Blockers

### B1. `affected --vitest`: tests added to (or moved inside) a changed test file are not run

Repro (`lab`, map `raw-lab`):

```
echo "it('NEW regression test appended at the end', () => { expect(price(1, 1)).toBe(999); });" >> test/price.test.ts
vto affected ../raw-lab --git HEAD --vitest --print0 | xargs -0 -r npx vitest run     # the README pipeline
```

Observed: `vto: 6 of 27 tests affected`, Vitest `Tests 6 passed | 1 skipped (7)`, exit 0. `npx vitest run`:
`FAIL test/price.test.ts > NEW regression test appended at the end`.
Expected: a changed test file runs completely.
Variants: inserting the test above the others (S4) or shifting lines (S4b) gives
`Error: No test found in test/price.test.ts in lines 4, 5`: the run is red, but the edited test never executes.
A renamed and edited test file (S25) is requested under its old path only.

Root cause: `analyzer/src/main.rs:571-579` prints one `./file:line` filter per *recorded* unit, with the line recorded
at collection time. `affected.rs:517` (`find_test(old)` → `sel_test_files`) knows the file changed, but that knowledge
is lost in the output; a rename never looks at `ch.new`.

Fix: for every test file in `sel_test_files`, and for every file in the default file granularity, print the bare file
filter (`./test/price.test.ts`). Keep `:line` only under `--test-granularity` and never for a changed test file. For a
renamed test file print the new path. This also fixes M5.

### B2. The ignore list is applied before the map is consulted

Repro: `sed -i 's/format(n)/fmt(n)/' docs/api.md` (S3), or `sed -i 's/price, format/price/' README.md` (S3b).
Observed: `vto: ignored docs/api.md`, `0 of 27 tests affected`, exit 0, `[]`. Full run: `docs.test.ts` fails
(`help.test.ts` for the README). The map knows both edges: `fileload.reads` of `test/docs.test.ts` contains
`docs/api.md`, `fileload.modules` of `test/help.test.ts` contains `README.md`.

Root cause: `affected.rs:463-466`. `is_ignored` → `continue` runs before the `reads` loop (line 470) and before the
module lookup. `DEFAULT_IGNORE` contains `*.md` and `docs/**` (lines 205-211). The daemon has the same result for a
different reason: files read through `fs` are not tracked at all (M4).

Fix: skip a path only when it is ignored **and** unknown to the map (no test file, no module, no `reads` entry equal to
or above it). Treat the ignore list as "do not force run-all for unknown files of this kind".

### B3. Dependencies loaded after the first `beforeAll` are not recorded

Repro S1 (very common pattern for env-dependent config modules):

```ts
// test/lazy.test.ts
beforeEach(() => { vi.resetModules(); });
it('tax uses the configured rate', async () => { const m = await import('../src/config'); expect(m.tax(100)).toBe(20); });
```

`sed -i 's/0.2/0.3/' src/config.ts` → `vto: src/config.ts: line 1 outside any block (top level) → every test file
importing it`, then only the two glob guards are selected; exit 0; the full run fails `lazy.test.ts`.
S1b is the `React.lazy` / route-splitting shape: `page.test.ts` imports `src/page.ts` statically, `app.test.ts` reaches
it through `await import('./page')`; only `page.test.ts` is selected.

Raw data: `{"testFile":"test/lazy.test.ts","modules":[] …}` and `test/app.test.ts modules=['src/app.ts']`, although
both tests have `hits` in the lazily loaded file.

Root cause: `collector/setup-v2.mjs:172-186`. `modules` is `Object.keys(reg)` plus `evaluatedModules` taken once, in
vto's own `beforeAll`, and never refreshed. `afterAll` (line 226 ff.) merges hits only. `affected.rs:596-601` then
selects loaders only through `fileload.modules`.
The consistency check at `affected.rs:528` does not help: it passes because some test hit the file.

Fix (both): (1) collector: recompute the module list in `afterAll` and union it. (2) analyzer: for a file-level
change of file F also select every test file that has a unit with any hit in F or `fileload.hits` in F. The daemon's
`loadersOf` (`mcp/src/store.mjs:133-140`) already does this, but selection goes through the analyzer.
Non-instrumented lazy modules (JSON, CSS, `?raw`) need fix (1).

### B4. A changed line that holds both top-level data and a nested function body

Repro S2:

```ts
// src/columns.ts
export const columns = [
  { key: 'name', label: 'Name', render: (r: any) => String(r.name) },   // line 2
```

`sed -i "s/label: 'Name'/label: 'Customer'/" src/columns.ts` → selected: `columns.test.ts` (calls `render`) and the
glob guards; exit 0. `header.test.ts` (`expect(columns.map(c => c.label)).toEqual(['Name','Qty'])`) fails in the full
run and was not selected. Same shape: column/route/menu tables, zod schemas with `.refine(…)`, option objects with
callbacks, styled-components templates.

Root cause: `affected.rs:562-584`. The file-level rule fires only when **no** block overlaps the line
(`c.is_empty()`), or an overlapping block ran at import time. Module top level has no block of its own, so a line
partly inside the arrow's block counts as "inside blocks". `mcp/src/store.mjs:392-406` (`fileLevelChange`) mirrors the
same rule.

Fix: decide by containment. A changed line is block-local only if some block strictly contains the whole line (starts
on an earlier line and ends on a later one, or column data proves the line lies inside it). Otherwise treat it as
top-level → every loader. Alternative: let the instrumenter emit the line ranges of top-level statements and treat any
change inside them as file-level.

---

## Major

### M1. `reads` does not see child processes, worker threads, or fd-based reads

- S6 (false green): `test/cli.test.ts` runs `execFileSync(process.execPath, ['bin/cli.mjs', 'bob'])`; `bin/cli.mjs`
  imports `src/lib.mjs`, which a unit test also imports. Editing `lib.mjs` selects only `lib.test.ts`; exit 0; the CLI
  test fails in the full run. Typical for CLI and integration tests in node projects.
- S9: of six source-guard tests over `src/price.ts`, the collector recorded reads for `fs.globSync` + `readFileSync`
  and for tinyglobby. Not recorded: `fs.openSync` + `readFileSync(fd)`, `fs/promises.open().readFile()`,
  `execSync('grep …')`, and a `Worker` that reads the file. Each of those four is a false green when it is the only
  guard.

Root cause: `collector/setup-v2.mjs:140-142` wraps a fixed list of path-taking functions of the worker's `fs`
(`open*`, `FileHandle`, `cp`, `readlink`, `realpath`, `watch` are missing). Other processes and threads have their own
`fs`. When the file is unknown to the map the result is run-all (safe); the miss happens when another test put the
file into the map.

Fix: wrap `open`/`openSync`/`promises.open` (and record the path). For test files that import `node:child_process` or
`node:worker_threads` (statically visible, like the existing `uses_fs` fallback in `main.rs`) select the file
for every change, or let users declare inputs (`// vto-inputs: src/**, bin/**`).

### M2. Renames skip the "new file" rule; the daemon has no "new file" rule

S7: `git mv src/disabled/extra.ts src/plugins/extra.ts` (plus the import fix in its own test). `src/registry.ts` uses
`import.meta.glob('./plugins/*.ts', { eager: true })`. Observed: `module without blocks → every test file importing
it`, 3 tests selected, exit 0; `registry.test.ts` fails in the full run. A plain *new* file at that path gives
`new file, unknown to the coverage map` → run all, so the protection exists and the rename path bypasses it
(`main.rs:426` passes `-M`; `affected.rs:537-546` handles `renamed` only through the old path).
D7b: the daemon, given a brand-new `src/plugins/b.ts`, ran 0 tests, exit 0. `changedFiles` (`mcp/src/select.mjs:40-51`)
iterates tracked files only, and only new *test* files are detected.

Fix: analyzer: when `new` differs from `old`, additionally apply the new-file rule to `new` (run all unless it is a
known test file). Daemon: scan for untracked source files under the project root (the scanner already stats files) and
run all, or at least every test file whose `modules`/`reads` include the new file's directory.

### M3. Tests that fail during collection are trusted with truncated coverage

Repro (`lab-sem`): `test/job.test.ts` calls `runSerialized(double, 21)` (builds a function from `fn.toString()`), then
`expect(label(r)).toBe('n=42')`. Plain run: 2 passed. Collection: `ReferenceError: __vto_k is not defined` (m2), the
test is recorded with `"state":"fail"` and no hit in `src/label.ts`; `run-raw.mjs` exits 1 but writes the map.
Then `sed -i "s/'n=' + n/'N=' + n/" src/label.ts` → `vto affected` prints `[]`, exit 0; the full run fails the test.
The same happens to any test that fails or times out in the collection run only. VALIDATION-real-suite C2 reports
exactly such load-induced failures in collection runs.

Root cause: `affected.rs:617-623` selects units by `items` regardless of state; `analysis.rs` excludes failed units
from verdicts, `affected` does not. The daemon is safer here (previously failing tests stay selected).

Fix: in `affected`, always select units recorded as `fail`, `tainted` or `leaky` (their coverage is known to be
incomplete), and print a warning with their count; optionally refuse a map with failures unless `--allow-failed`.

### M4. Daemon map: `reads` dropped, and a miss becomes permanent

- `mcp/src/store.mjs:374-384` (`normFileload` / `unionFileload`) rebuild the fileload record from `hits`, `modules`,
  `loadMs` only. `reads` never reaches `.vto/map`, and `trackedFiles()` (line 126) does not include read files.
  Effect: D5 (`require('./legacy.cjs')`, caught by the CLI through `reads`) is a false green in the daemon; D3
  (`docs/api.md`) runs 0 tests.
- After a missed failure the map advances. D2 twice in a row: run 1 `ran 8, failed 0`, run 2 `ran 0, failed 0`, while
  `npx vitest run` still fails `header.test.ts`. The CLI path at least keeps reporting the diff against the base
  commit; the daemon forgets the edit (`ingest` step 1, `this.advance(f, cur)`).

Fix: keep `reads` in the stored fileload (union on partial runs), track read paths as files, select readers when a
read path changes; add a contract test "CLI map and daemon map select the same tests for the same diff".

### M5. Tests that did not run at collection time are never selected (CLI)

S8b: `it.runIf(process.env.FULL)(…)` in `test/ci-only.test.ts`; map recorded without `FULL`. An edit to `format()`
selects line 3 of that file only; with `FULL=1` the selected run is green and the full run fails. Skipped tests write
no record (`setup-v2.mjs` records in `beforeEach`). The same applies to a map recorded with a filter, one `--project`,
or with one shard's raw files missing: nothing checks that the map covers the suite.
Fix: B1's file-level filters cover the `runIf` case. For completeness record the collected test-file list and the
number of collected vs. recorded tests in `meta`, and make `affected` run all when the on-disk test-file list contains
files unknown to the map.

### M6. vm-guard `shared`: order-dependent false greens that `check` and `verify` do not see

Repro (`lab-vmg`, `mode: 'shared'`, `maxWorkers: 1`, 34 files): `a-setup-user.test.ts` calls
`registry.extend('currency')` on an external CommonJS package, `expect.extend({ toBeEven })`, and adds
`String.prototype.shout`. Three other files rely on each of these without setting them up.

| command | result |
|---|---|
| `VM_GUARD_MODE=isolated npx vitest run` (forks) | **3 failed** (`b-singleton`, `c-matcher`, `d-proto`) |
| `npx vitest run` with a cold Vitest cache (CI situation), 2 runs | 34 passed, exit 0, **no `[vm-guard]` warning** |
| same with `VM_GUARD_DIAG=1` | 34 passed, no warning |
| `vm-guard check --mode shared --no-plan` | `0 failing`, exit 0 |
| `vm-guard verify --mode shared --sample all` | `false-green 0, false-red 0`, exit 0 |
| `vm-guard check --mode shared` (planned) | 3 failing "also isolated", exit 1 |

Why `verify` misses it: `cli.mjs:287-289` runs the fast side through the planner (`cmdRunPlanned`), whose order put
the polluter last, so the three tests fail on both sides and "agree". The order CI actually uses (`vitest run`, Vitest's
sequencer) is never compared. With a warm cache Vitest runs previously failed files first, so the same suite flips
between red and green depending on cache state.
Why there is no dirty warning: the fingerprint (`setup.mjs` `beforeAllBody`) covers DOM, globals, known singletons
(i18next, TanStack) and, with `diag`, node_modules export state; it does not cover prototype extensions, matchers
added with `expect.extend` (`integritySnapshot()` compares a fixed list of core matchers only), or state of an external
module that is not exported.
Related, by code reading only (not reproduced): `mode: 'auto'` picks "the fastest mode without mismatches" from a
20-file sample per group (`cli.mjs:199-203`, `cmdCompare`); a file outside the sample that is green only in shared mode
is never compared again, because `check` re-runs failing files only.

Fix: `verify` must run the fast side in the same order as the gate (and at least one shuffled order); state plainly in
the README that `check` cannot detect false greens. Fingerprint `Object.getOwnPropertyNames` of the built-in
prototypes and the matcher list; reset `expect.extend` additions per file. Recommend `vm-guard run` (planned order) or
`vitest run` as the one supported gate command, not both. Keep a periodic full forks run.

### M7. vm-guard `check`: a deterministic vm-only failure is reported as FLAKY with exit 0

Repro (`lab-vmg2`, `mode: 'vm'`): `a-platform.test.ts` sets `util.inspect.defaultOptions.depth = 0` (outer-realm
state, not restored); `b-victim.test.ts` expects `util.inspect({a:{b:1}})` to be `'{ a: { b: 1 } }'`.
`vm-guard check --mode vm`, twice: `vm: 8 files, 1 failing … FLAKY (failed in vm, passed isolated and on a vm
re-run): test/b-victim.test.ts`, **exit 0, no quarantine**. `npx vitest run` (vm) fails that test on every run, exit 1.
`verify --mode vm --sample all` does report it (`false-red 1`, exit 2).

Root cause: `cli.mjs:225-228` re-runs only the candidate files; a victim without its polluter passes, and line 241
drops it from both `genuine` and `newQ`, so line 256 returns `EXIT.OK`. Shared mode hunts for a polluter; vm mode
does not.
Fix: confirm with the predecessors of the failing file from the run log (the `hunt` machinery), and never return 0
when a file failed in the fast run and was neither quarantined nor explained: use a distinct non-zero code for FLAKY.

### M8. verify: "confirmed redundant" for tests that differ only by a negative literal

Repro (`lab-ver`): `formatPrice()` without branches and three tests: `formatPrice(1234.5)`, `formatPrice(-1234.5)`
("keeps the minus sign attached for refunds (bug #812)"), `formatPrice(1234.005)` (float edge). All three have
identical coverage. `verify.mjs` → `confirmed redundant: 3, differs in assertions: 2, not refuted: 1`;
`verify.json` has `"verdict":"confirmed"` for the pair line 3 ↔ line 4 in both directions (15/15 mutants).
The pair line 5 → line 3 is correctly "not refuted … test bodies differ only in literals".

Root cause: `verify/static-features.mjs:58` replaces `Literal` nodes by `L`, but `-1234.5` is a `UnaryExpression`
around a literal, so the skeletons differ and `dataDriven()` (line 143-148) returns null; `verify.mjs:456-461` then
confirms. More generally, mutants of branch-free code cannot tell input partitions apart.
Also: `verify.md` shows the count "confirmed redundant 3" in the summary but lists no confirmed pair
(`report-md.mjs:68` filters candidates, not pairs), so the reader cannot see which pairs were meant.
Fix: fold unary `-`/`+`/`!`/`void` over literals into the literal; treat any pair whose call arguments differ as
"not refuted"; list confirmed pairs. Consider renaming the verdict to "no difference found (k mutants)".

### M9. `vitest-overlap.mjs` does not start

`node /home/claude/vto/vitest-overlap.mjs --raw …` → `SyntaxError: Unexpected identifier 'is'` at line 12. The usage
comment contains `findBy*/waitFor`, and `*/` closes the block comment (introduced with `--async-timeout`, `e6598d9`).
The documented user entrypoint is dead at HEAD; `collector/run-raw.mjs` + `vto` work when called directly.
Fix: write `findBy… / waitFor`; add a smoke test that executes the entrypoint with `--help`.

---

## Minor

- **m1. Changes hidden from `git diff` are invisible.** `git update-index --skip-worktree src/price.ts`, edit the
  file → `0 of 27 tests affected by 0 changed files`, exit 0. Same for `assume-unchanged` and for git-ignored inputs
  that tests import (generated code). Fix: compare the recorded `sha256` of every mapped file with the working tree
  (cheap: 12 files here, 429 in the real-world suite) instead of relying on git alone.
- **m2. Functions serialised with `toString()` break under instrumentation.** Probe results (`lab-sem`, 30 probes run
  plain and instrumented, JSON outputs diffed): everything identical except `Function.prototype.toString()` output
  and code built from it (`new Function('return (' + fn.toString() + ')(21)')` → `ReferenceError: __vto_k is not
  defined`). Affects worker/blob/`page.evaluate` helpers. On its own this is a false red in collection; with M3 it
  becomes a silent miss. The daemon's main lane is always instrumented, so such tests fail there on every run.
  Fix: document; offer `/* vto-ignore */` for a function; M3's fix removes the silent part.
- **m3.** `verify.json` mutant descriptions are Czech with `lang: en` (`"předčasný return na začátku funkce"`).
- **m4.** `vm-guard verify --no-plan` still prints a plan and runs planned (`--no-plan` appears to be honoured by
  `check` only).

## Checked and found sound

- **N1. Instrumentation semantics.** Identical results plain vs instrumented for: function `.length` and `.name`
  inference (conditional, logical assignment, destructuring defaults, class statics), getters with side effects and
  nested `||`/`&&`/`??` (single evaluation, shared temp variable re-entrancy), `this` binding of call forms, generators
  with `yield` in logical expressions, async generators and `for await`, labelled `break`/`continue`, switch
  fall-through with and without `default`, ASI hazards (lines starting with `[`, `(`, template), `do … while` and
  brace-less bodies, `try/finally` overriding returns, derived-class constructors before `super()`, static blocks,
  tagged template identity, direct vs indirect `eval`, `arguments`, destructuring default order, optional chaining,
  stack-trace line of a source function. `with` and sloppy-mode cases cannot occur (files are parsed as modules).
- **N2. Daemon map patching, line-level edits.** `harness/fuzz.mjs`: generated project (6 modules with branches,
  loops, memo caches, a dependency chain; 56 tests), random sequences of comment insert/delete, numeric edits, added
  branches, top-of-file blank lines and reverts, 1–2 edits per step, `run-affected` after every step. After each step:
  (a) every failure of a plain full run must be in the daemon's `state.failing`; (b) a fresh full collection of the
  same tree in a clean copy must not contain hits or modules missing from the daemon map (dirty/failing tests excused).
  Seeds 1–3, 97 executed steps: **0 missed failures, 0 under-approximated maps, 0 invalid block ids.** (Seed 1's log
  shows "MISSED" lines in 4 steps; that was my harness reading the JSON answer, which caps `failures` at 5 groups. In
  each of those steps the daemon's `failed` count equals the full run's count. Fixed for seeds 2–3 by reading
  `state.json`; seed 1 was not re-run.) Limits: node-only project, no lazy imports, no test-file edits, no fs readers;
  the drift found in M4 lies outside this fuzz model.
- **N3. Unknown files.** New files, files outside the map, config/lockfile/setup changes produce run-all (exit 3) in
  the CLI. `require()` of a project `.cjs` is caught through the CJS loader's `readFileSync`. `fs.globSync` and
  tinyglobby directory scans are recorded as directory reads.
- **N4. vm-guard `vm`.** A `vi.spyOn(os, 'platform')` / `vi.spyOn(fs, 'existsSync')` left behind by one file was
  detected (`patched builtins [node:fs.existsSync, node:os.platform]`) and did not change later files; results equal
  forks. External CommonJS singletons are per context in vm mode (the shared-mode leak of M6 does not exist there).
- **N5. Overlap report wording.** `report.md` opens with "This is not a list of tests to delete", the greedy minimal
  set is a statistic only, and no-coverage tests are listed as "cannot be evaluated … does not mean the test is
  useless". I found nothing in the analyzer report that tells a user to delete a test; the risk sits in `verify` (M8).

## Not tested

Case-only renames on a case-insensitive FS, maps from another OS/root, shallow clones and merge commits (code reading:
unresolvable or mismatching base → run all), `Symbol.hasInstance` shims hiding type bugs, `auto` with
`nodeEnvironment: 'node'` (tests that early-return on `typeof window === 'undefined'` would pass vacuously in the node
group; plausible from `setup.mjs` since passing files are never moved back), quarantine `--prune`, the real-world suite and
bench-project (all experiments ran on small purpose-built projects), Windows.

## Go / no-go

- **`vto affected` as a CI gate: no-go.** Four independent, common code shapes give exit 0 with a failing test (B1–B4),
  and five more do under less common conditions (M1–M5). Acceptable today only as an accelerator in front of a full
  suite that still gates the merge (merge queue / main), which is what FORMAT.md already recommends. Re-evaluate after
  B1–B4 and M3 are fixed and `harness/aff.mjs` is green; adding `--importers` does not fix B1–B3.
- **`vto-daemon run-affected` for agent loops: usable as a fast first signal, not as the final check.** It handles
  test-file edits correctly, but shares B2–B4, drops `reads`, ignores new files, and forgets a missed edit after one
  run. Finish every task with a full uninstrumented run (`--full --clean`).
- **vm-guard `vm`: go, with the gate being Vitest's own exit code.** Results matched forks in every probe. Do not use
  `vm-guard check`'s exit code as the gate until M7 is fixed.
- **vm-guard `shared` / `auto` (when it picks shared): no-go as the only gate.** A suite can be green in shared mode
  with tests that fail in isolation, without any warning, and `verify --sample all` can certify it. Use it for local
  speed and keep a scheduled forks run.
