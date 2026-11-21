# vto – independent review #1

Reviewer: independent agent. No production code was changed. Reviewed state: `FORMAT.md` (v1 and v2),
`collector/{setup.ts,run-raw.mjs,plugin.mjs,setup-v2.mjs,selftest.mjs,corpus/}`, `analyzer/src/*.rs`
(the binary builds; `affected`, `analysis`, `report` and `raw` are present). Files were changing while I
read them. Where a finding refers to code, it is the state at the time of this review (2026-11-20).

All experiments are reproducible under `/home/claude/review-scratch/` (Vitest 5.1.1, Vite 8.3.8,
@vitejs/plugin-react 6.3.0, oxc-parser 0.159, React 19 + RTL + jsdom):

| dir | what it proves |
|---|---|
| `p1/` | attribution: lazy init, timer leak, unmount and hook order, `test.concurrent`, identical React renders, v1 overhead (`timeit.mjs`) |
| `p2/` | exact Vitest hook order (setupFiles order × afterEach × onTestFinished × retry) |
| `p3/` | circular-import crash with the **real** `plugin.mjs`; `vi.resetModules` orphaned arrays; prototype of the fix (`vto-proto-plugin.ts`) |
| `p4/` | plugin order vs `react({ compiler: true })` |
| `p5/` | end-to-end `vto affected` false negatives, checked against real test failures (git repo inside) |
| `adv.mjs`, `naive.mjs`, `oxc-probe.mjs` | syntax edge cases against `instrument()` and oxc span facts |
| `bench.mjs` | per-test collection cost and raw size for v2 |

Severity: **blocker** = gives wrong results with no warning, or crashes user code; **major** = often
misleading or a large cost; **minor** = edge case, cosmetic, or cheap hardening.

---

## BLOCKERS

### B1. `affected`: code that runs at module top level is never attributed. Changing a constant selects no tests and exits 0
- **Scenario:** `src/disc.ts` has `export const RATE = 0.21`, and test `rate constant` checks `RATE*100 === 21`.
  You change it to `0.2`. Because the line is outside every block, `affected` widens to "all tests touching the
  file". The test that depends on `RATE` touches no block, so it is **not selected**. Exit code 0.
- **Evidence (p5):** `vto affected` selected 4 of 5 tests, without `rate constant`. A plain run of the changed code: `× rate constant`.
- **Why it happens:** import-time code runs during collection, before the first `beforeEach` reset. Top-level
  statements also get no markers (`visitList(…, topLevel=true)`). The same gap applies to `createContext`
  defaults, `styled.x` definitions, route tables, i18n dictionaries, zod schemas, `export const cfg = {...}`,
  barrels and re-exports, and any module that is only constants (pure data modules don't appear in any test's hits).
- **Fix:**
  1. Record **file-level dependencies per test file**: the set of instrumented modules *evaluated* in that test
     file's worker context. The registry keys that exist at the end of collection are enough for this. Better:
     also snapshot the import-phase hits once per test file. Take the snapshot in the setup file's first
     `beforeEach`, before `reset()`, or in a custom runner's `importFile` / `onCollectFinished`. Emit it as
     `{"t":"filedeps","file":<test file>,"modules":[...],"importHits":{...}}`.
  2. In `affected`, a change outside function-body blocks selects **every test in every test file whose
     filedeps contain the module**. Don't limit it to "tests touching the file".
  3. Also take Vitest's module graph (`project.vite.moduleGraph` / per-file import list) as a safety net for
     modules that aren't instrumented (JSON, CSS, `?raw`, svg). See M10.

### B2. `affected`: the "innermost block" rule is wrong for decision lines. Changing a `case` label selects 0 tests
- **Scenario:** `switch (x) { case 1: …; case 2: return 'two'; } return 'other'`, and test `kind three` calls `kind(3)`.
  You change `case 2:` to `case 3:`. The changed line lies inside the case-2 block (no test hit it) and the
  implicit-default block (whose span is the whole switch). The innermost is case-2, so the result is **0 of 5 tests, exit 0**.
- **Evidence (p5):** `vto: 0 of 5 tests affected`. A plain run: `× kind three`.
- **Same class of bug:** the switch discriminant line, `case` tests, an implicit-`else` region whose span covers the
  `if` test when the consequent starts on a later line, loop headers (`for (…; i < n; …)` is in the loop-body
  block's parent only if spans line up), `catch (e)` binding, logical left operands whose block id records
  *short-circuit taken*, and default parameter values on the function line.
- **Fix:** map a changed line to the smallest block that contains the **whole statement or decision** containing
  the change (if-test → the block that runs the `if`; case test → the block that runs the `switch`). Do not
  use the smallest span that happens to contain the line. The instrumenter already knows the structure: emit
  `parent` per block, plus a list of "decision" spans (if/switch/case/loop tests, conditional tests, logical
  left operands) that must map to the parent. Until this exists, make `--broad` the default. Validate with
  fault injection (§7).

### B3. Instrumented modules crash in circular imports
- **Scenario:** `a.ts` imports `b.ts`, and `b.ts` calls the hoisted `export function helper()` from `a.ts` at top
  level. Without vto this works. Function declarations are hoisted and Vite SSR exports are getters. With vto,
  `var __vto_k=(function(){…})()` hasn't run yet, so `helper` runs `__vto_k[0]=1` and throws
  `TypeError: Cannot set properties of undefined`. The whole test file fails.
- **Evidence (p3):** the current `collector/plugin.mjs` fails with `❯ src/b.ts:2:24 ❯ src/a.ts:1:1`. Without the
  plugin, 1 test passes. A `const` prelude fails with a TDZ `ReferenceError` instead. Circular imports are common
  in real React apps: stores ↔ selectors, component barrels, `index.ts` re-exports.
- **Fix (verified in `p3/vto-proto-plugin.ts`):** use a hoisted getter.
  `var __vto_k; function __vto_i(){return __vto_k=(reg[key]||(reg[key]=new Uint8Array(N)))}`, with markers
  `(__vto_k||__vto_i())[i]=1` and helpers `__vto_a/o/n` that use the same getter. The cost is one extra truthy
  check per marker. Add this case to the corpus.

### B4. The report presents the greedy cover's complement and no-coverage tests as savings ("bezpečná úspora")
- **Scenario:** `renders A` and `renders B` render `<Counter label="A|B"/>` and assert different text. They end up in
  "Shodné pokrytí" (identical coverage), and one of them in "Testy bez pokrytí navíc" (tests adding no coverage).
  The JSON field is `no_extra_coverage`, internally `removable`. The text then says "bezpečná úspora podle
  minimální sady je 17.8 ms" ("safe saving according to the minimal set"). `rate constant` from B1 would sit under
  "Testy bez vlastního pokrytí … čisté mocky" ("tests without their own coverage … pure mocks"), and `removable_ms`
  counts those as savings.
- **Evidence (p1 → analyzer `report.md`):** both render tests are listed as group 1 with identical coverage.
- **Why it's wrong:** branch coverage can't see data. Props that only flow into `{label}`, boundary values (`99`,
  `100`, `101` around `>= 100`), and different assertions on the same path are all invisible to it. Greedy set
  cover is only an approximation (ln n). Ties are broken by unit order, so the "keep" set is arbitrary and
  unstable. Any change in order (M2) or leaks (M1) shuffles it. No-coverage can also mean the coverage was
  *lost* (M1, M3, B1). It doesn't mean "useless".
- **Fix:** see M5 for the extra signals. In the report:
  - Never write "removable", "safe" or "bezpečná". Call them "candidates for review" and attach a reason code
    (`same-coverage`, `same-coverage+same-assertions`, `same-dom`…).
  - Show the minimal set only as a coverage statistic. Never show it as a list of tests.
  - List no-coverage tests under "nelze vyhodnotit" ("cannot be evaluated") with possible causes.
  - Exclude failed, tainted and leaky units from all conclusions.

---

## MAJOR

### M1. Async work that outlives a test is attributed to a later test, or lost
- **Evidence (p1, v1 and v2 both):** `schedules leak` calls `setTimeout(leaked, 1)` without awaiting. Its hits are
  `leak.ts@L4` only. The *next* test, `innocent async`, gets `leaked()` (`L1,5`). Nothing is tainted.
  The same happens with RTL tests that end before a fetch/MSW response or a `setTimeout`-driven `setState`
  arrives, and with `waitFor` timeouts or un-awaited `user.click`.
- **Already good:** v2 collects in `onTestFinished` (verified in p2: it runs after every `afterEach`, including a
  user setup file's RTL `cleanup`). So unmount effects are attributed correctly. With v1/run-raw they were
  **lost** when the user's setup file came first (p1 `b.test.tsx`, `onUnmount` missing).
- **Fix (cheap):** don't reset at the end. At the next `beforeEach`, **collect before reset**. Anything non-zero
  is a *late hit* from the previous test (or from `afterAll`/`beforeAll` of the previous suite). Record it as
  `late` on the previous unit and mark that unit `leaky`. Mark the receiving test `contaminated` only if late
  hits keep arriving during its own run. That can't be told apart from its own hits, so use Vitest 5
  `detectAsyncLeaks` (present in the 5.1 config) or a check of pending timers/handles as a heuristic. Exclude
  leaky and contaminated units from identity and subset verdicts.

### M2. Order dependence: lazy singletons, memo caches and one-time init give unique atoms to the first test only
- **Evidence (p1):** `lazy first` hits `L2,7,8,11` (including `init()`), and `lazy second` hits `L7,8,11`. Reorder the
  tests and the verdict flips. Typical React sources: i18next init, `QueryClient` and store singletons, `React.lazy`
  first resolution, `memoize` caches, `useSyncExternalStore` module stores. With `isolate:false`, this crosses
  test files.
- **Fix:** run a **metamorphic pass**. With v2 it's cheap: the suite runs about 1.1–1.3× normal speed. Re-run with
  `--sequence.shuffle --sequence.seed=<k>` (two seeds, or per-file reverse order). Mark atoms whose attribution
  changes as `order-dependent` and keep them out of equality and subset tests. Report them as a feature
  ("tests that depend on order").

### M3. `test.concurrent`: the taint check misses the first-started test, and the analyzer ignores `tainted`
- **Evidence (p1 `c.test.tsx`, v2):** `conc A` starts first and `conc B` second. B is tainted. A finishes last,
  when `S.active` is back to 1, so A is **not tainted**. Yet A holds B's hits (`leak.ts@L1`), and B's `reset()`
  wiped A's earlier hits. `raw.rs` deserializes `tainted` into nothing, so both are analysed as clean.
- **Fix:**
  - Force `maxConcurrency: 1` and `sequence.concurrent: false` in vto runs. `test.concurrent` then runs serially.
  - Keep taint as a safety net, but taint **every** test active during an overlap (keep a set of active ids).
  - Make the analyzer drop tainted units from verdicts and list them.
  - `describe.concurrent` and `sequence.hooks:'parallel'` need the same treatment.

### M4. Shared `beforeEach` and render helpers inflate overlap
- **Evidence (p2):** user `beforeEach` hooks from setup files that come *after* vto, and all test-file hooks, run
  after `reset()`. They count as the test. A `describe` with `beforeEach(() => render(<Page/>))` makes every test
  in it look ≈identical, and the real differences drown at Jaccard 0.9.
- **Fix:**
  - Split hits by phase. Take a "setup" snapshot after the last `beforeEach` and before the body. This needs a
    hook at that point: a custom runner (`runner:` option, extend `VitestTestRunner`) that appends a final
    `beforeEach` to each suite in `onBeforeRunSuite`. Alternatively, run beforeEach in `list` order and register
    a suite-level hook through `onCollected`.
  - Compare on **body** atoms, and keep setup atoms as context.
  - Add IDF weighting: atoms hit by >50 % of the tests in a file or project, such as layout components, providers
    and test utils, carry little weight in near-duplicate scores.

### M5. Coverage-equal is not redundant: add cheap extra signals
These are ordered by cost/benefit. All of them can be computed in the existing setup file or in an oxc pass over test files.
1. **DOM fingerprint**: hash `document.body.innerHTML`, and optionally a text-only and roles-only projection,
   at the start of `onTestFinished` *before* cleanup. One serialization is about 10–200 µs for typical RTL DOMs.
   `renders A` and `renders B` differ immediately. Hook order needs care: our callback runs after the user's
   `cleanup`, so capture it in an `afterEach` registered *last* (test-file level is impossible), or patch RTL
   `cleanup` to snapshot first, which is simpler and robust.
2. **Assertion fingerprint**: `chai.use((c,u)=>{ wrap c.Assertion.prototype.assert })`, imported from `vitest`'s
   `chai` in the setup file. Record (matcher, hash(expected), pass) per test. It costs µs. It separates
   same-path/different-expectation tests and catches boundary tests (`toBe(100)` vs `toBe(101)`).
3. **Static test features** from an oxc parse of the test file. Collect the rendered JSX element and its literal
   props, RTL queries with role/name/text args, `userEvent.*` calls, mocked modules and matcher names. It's free
   at run time and gives a human-readable reason in the report.
4. **Boundary heuristic**: mark atoms that are arms of numeric comparisons (`<`, `<=`, `>=`, `===` against
   literals). If two tests differ only in numeric literal args, label them `boundary-pair, keep both`.
5. Optional, for later: per-atom *value* buckets at comparisons (sign of `a-b`). This is mutation-like and
   expensive, so keep it out of the default path.

Verdict tiers: `identical(coverage ∧ assertions ∧ DOM)` → strong candidate. `coverage only` → "overlapping,
check manually". Never output a deletion list.

### M6. Plugin order: an earlier `pre` transform (React Compiler, auto-import, babel macros) breaks positions or changes semantics
- **Evidence (p4):** with `plugins: [react({compiler:true}), vto()]`, vto receives compiled code
  (`import { c as _c } from "react/compiler-runtime"; var _jsxFileName …`). Block lines/columns then point into
  compiled output, which also has memo-cache branches (`if ($[0] !== x)`). Those become atoms that depend on
  render count, not on behaviour. With `[vto(), react({compiler:true})]`, the compiler **no longer compiles** the
  component (no `_c` in the output), because of the module-level mutation in render. So tests run different code
  than in CI. `unplugin-auto-import` and similar inject imports and shift every line.
- **Fix:**
  - Use `transform: { order: 'pre', handler }` and move vto to index 0 in `configResolved`. Many plugins do this.
  - In `transform`, check `code === readFileSync(file)` (or a hash). If it differs, map positions through
    `this.getCombinedSourcemap()`, or skip the file and warn.
  - Detect `vite:react-compiler`. Documented choice: instrument *after* the compiler with source-map
    back-mapping, and drop atoms that don't map to original code. Otherwise, warn that compiled components are
    measured uncompiled.
  - Add a corpus case with the compiler on.

### M7. Unit identity merges `it.each` and loop-generated tests, and ids fall back to the name
- **Scenario:** `it.each(rows)` or `for (const c of cases) test(c.name, …)` share one location line. `UnitBuilder`
  merges them into one unit with the union of their hits, so redundancy *between rows* (the most common kind) can
  never be reported. Also, without `includeTaskLocation`, the line is `null` and ids become `file:?name`. p5 and p1
  show `test/d.test.ts:?big order`.
- **Fix:** unit = (file, full name, line). Group by line only in the presentation. The vto runner must always
  force `includeTaskLocation: true`. The analyzer should warn when location is missing.

### M8. Failed, skipped and flaky tests pollute verdicts
- Failed units take part in subset checks and the set cover (their coverage is truncated).
- In `setup-v2`, `state === 'fail' ? 'fail' : 'pass'` turns runtime `ctx.skip()` / `skipIf` into `pass` with partial hits.
- Retries: "last attempt wins" is right, but the first attempt's hits differ. Flag `retried` units as unstable.
- **Fix:** carry `state ∈ {pass, fail, skip}`, `retryCount` and `tainted`/`leaky`. The analyzer computes verdicts
  only on clean passing units.

### M9. Scale: raw size and output size, rather than the algorithms
- The algorithms are sound: hash grouping, rarest-item subset candidates, AllPairs prefix filtering and lazy
  greedy, with a brute-force cross-check test. The risks are elsewhere:
  - **Raw size.** `bench.mjs` with 60 touched files and 1/3 of blocks hit gives about 22 KB JSON per test, which
    is about 220 MB for 10k tests when an app-level `render(<App/>)` is common. Fix: intern per-file hit lists
    per worker (`{"t":"set","id":17,"file":…,"ids":[…]}`, tests reference set ids). Encode as delta-varint or
    bitset base64. Expect 10–50× smaller.
  - **Output blow-up.** `subsumed` stores the full superset list per unit (O(n²) entries when 5k tests ⊂ 5k
    others), and near pairs are expanded `members×members` across identical groups. Fix: keep top-k (e.g. 5)
    supersets and the total count, report near pairs between *representatives*, and cluster with union-find.
  - **Prefix filtering at low thresholds or with dense shared setup** degrades towards O(n²). Fix: compute on body
    atoms with IDF (M4), restrict default comparisons to the same test file or same component, and run a global
    scan only on demand.
- Collection cost is fine (see §5).

### M10. `affected`: inputs other than block-mapped code
Status in the current `affected.rs`: new files and files unknown to the map lead to exit 3 ("run all"). That is
correct and safe. A changed test file selects the whole file, which is good. Gaps:
- **Non-instrumented imports** (JSON, CSS modules, svg/`?react`, `?raw`, `.env*` via `import.meta.env`, `define`,
  `vite.config`/`vitest.config`, `tsconfig` paths, `package.json`/lockfile, setup files, `__mocks__/`,
  MSW handlers, `__snapshots__/*.snap`, `test/fixtures/*`). Any of these that is **known** to the map (e.g. a
  setup file that was excluded from instrumentation, but `find_test` doesn't match it) or matched by suffix
  ambiguity may still slip. Fix: an explicit rule table:
  - config, package, lock, setup and tsconfig changes → run all;
  - snapshot change → its test file;
  - any other file → every test file whose Vitest module graph contains it.
- **Stale maps.** Only `gitHead` is recorded. A map recorded on a dirty tree, or on a commit other than the diff
  base, is used anyway (a warning only). Fix: store a content hash per instrumented file. When the base-side
  content of a changed file ≠ the recorded hash, select every test of every test file that depends on it.
  `--base` must be mandatory in CI. vto should run `git diff <recorded gitHead>` itself, so users can't pick the
  wrong side.
- **Type-only changes:** today they widen to "all tests touching the file". That's safe, but if a later
  optimisation skips them, keep `const enum`, `emitDecoratorMetadata`, `declare` + runtime side effects and
  typecheck tests (`expectTypeOf`, `vitest --typecheck`) in mind. Never skip when typecheck mode is enabled.
- **Barrels and re-exports:** fine once B1 is fixed (file-level deps). Not fine today: a re-export change is a
  top-level line → "tests touching the file". Tests that touch nothing in the barrel itself get nothing.
- **Dynamic `import()` / `React.lazy`:** fine once the module evaluated at least once in the test. Otherwise it's
  the same as B1.
- **Product positioning:** benchmark against `vitest --changed` / `vitest related` (file-level, module graph).
  vto's set should be ⊆ that set. A test in vto's set but not in `related` indicates a bug, and the size ratio is
  the value proposition.

### M11. Windows: distribution and paths
- **Distribution:** ship the analyzer as a plain CLI binary in per-platform npm packages through
  `optionalDependencies` (`@kral/vto-cli-win32-x64-msvc`, `-win32-arm64-msvc`, `-linux-x64-gnu`, `-linux-x64-musl`,
  `-darwin-arm64`, `-darwin-x64`), plus a tiny JS shim in `bin`. This is the oxlint/biome/esbuild pattern, and
  oxc-parser in the collector already depends on it.
  - Build natively on GitHub Actions `windows-latest` (MSVC) rather than cross-compiling. If you must
    cross-compile, `cargo-xwin` works. Use static CRT (`-C target-feature=+crt-static`) to avoid a VC++
    redistributable dependency.
  - Fallback: `wasm32-wasip1` with rayon disabled, run via `node:wasi`, for `--omit=optional` installs and odd
    platforms. It's 1.5–3× slower, but it still works.
  - napi-rs only pays off if you want in-process analysis, e.g. streaming hits from the Vitest main process
    without JSONL. Not needed for v1 of the product.
  - Pin the Rust edition 2024 toolchain (≥1.85) in CI.
- **Paths:**
  - Vite ids are `C:/x/y.ts`, `process.cwd()` is `C:\x`, V8 URLs are `file:///C:/x`, and git gives repo-relative
    `/` paths. `paths.rs` handles drive letters and case-insensitive *prefix* comparison. But `FileTable::intern`
    is case-sensitive, so `c:/…` and `C:/…`, or `./Button` vs `./button` imports (two Vite module instances on
    NTFS), become two files. Fix: canonicalise the drive letter to upper case. On win32 and darwin, intern on a
    case-folded key and keep the display form.
  - `v1 setup.ts` builds `'file://' + filepath`, which gives `file://C:/…` (two slashes) ≠ V8's `file:///C:/…`.
    Use `pathToFileURL`.
  - UNC paths, `subst` drives and junctions can make Vite's realpath differ from git's path. Resolve both with
    `realpath` before comparing.
  - CRLF: line indexing counts only `\n`, which is fine for both LF and CRLF. Keep it that way, and add a CRLF
    corpus case, since git `autocrlf=true` is the Windows default.
  - Git paths: non-ASCII file names are octal-quoted (`"src/Ulo\305\276it.tsx"`, `core.quotePath`).
    `strip_path` only trims quotes, so such files become "unknown" (fail-safe, but always exit 3 for Czech file
    names). `diff.mnemonicPrefix` / `diff.noprefix` user configs break the `a/`/`b/` stripping. Fix: vto runs
    `git -c core.quotePath=false diff --no-ext-diff --no-color -M -U0 --src-prefix=a/ --dst-prefix=b/`
    itself.
- **CI:**
  - Raw file names `w-<pid>-<thread>` collide when shards from several machines are merged into one directory
    (containers reuse small pids). `appendFileSync` into an existing raw dir silently mixes runs. Fix: add a
    run-id/shard prefix and clear the directory at start (or refuse if it isn't empty).
  - Add a documented `vto merge` for `--shard` outputs, a map cache keyed by commit, and a fail-open policy
    (exit 3 ⇒ the pipeline runs everything).
  - `process.on('exit')` doesn't fire reliably when worker threads are terminated, but the `afterAll` flush makes
    this a non-issue unless the run bails.

### M12. Validation independence (see §7 for the plan)
The corpus (`collector/corpus`) and its ground truth (`/*@hit*/`, `/*@never*/`) come from the same agent that writes
the collector. Shared misconceptions pass silently. B2 and B3 were not caught by `selftest.mjs`, and
`selftest.mjs` passes.

---

## MINOR

- **m1. Setup file outside the Vitest root fails to load:** `Cannot find module '/@fs/home/claude/vto/collector/setup.ts'`
  for both `setup.ts` and `setup-v2.mjs` (p1). Dev-only, but monorepos with hoisted `node_modules` above the
  project root can hit it too. Fix: resolve and pass it as a `file://` URL, or add `server.fs.allow`.
- **m2. v1 filter keeps the user's setup files as project code:** `user.setup.ts` shows up in per-test coverage (p1
  `c.test.tsx`). v2 excludes `setupFiles`, but test utilities (`src/test-utils.tsx`, `src/mocks/handlers.ts`,
  `test/helpers.ts`) are still instrumented as product code. That's right for `affected`, but it inflates overlap.
  Use a per-file role (`product`/`test-support`) via config globs, plus IDF weighting.
- **m3. Registry reuse checks only `a.length === N`:** in a long-lived worker (watch, `isolate:false`), an edited file
  with the same block count but a different layout reuses the old array, and `__vto_blk` is overwritten. The ids'
  meaning changes mid-run. Key on a hash of the block table.
  (`vi.resetModules` orphaning is otherwise fixed by the reuse. A naive per-instance array loses hits, shown in p3.)
- **m4.** Functions inside `namespace` and enum initialiser calls are not instrumented (`adv.mjs`: `namespaceFn` → null).
  Document it, or instrument namespace bodies (runtime code).
- **m5.** Code in `beforeAll` (e.g. `render` in `beforeAll`, MSW `server.listen`) is attributed to nobody. Attribute
  it to the suite as setup atoms (same mechanism as B1).
- **m6. `durationMs` of the first test in a file includes lazy import and JIT warm-up:** p1 shows `renders A` 54.9 ms vs
  `renders B` 3.8 ms. "Slow tests without benefit" therefore ranks first tests too high. Use the median of
  siblings, or exclude the first test in a file from the ranking.
- **m7. Decorators:** oxc puts `ExportNamedDeclaration.start` *after* a leading decorator (`@dec\nexport class`, start=5).
  Inserting at statement start would produce `@dec <marker> export class`, which is a syntax error (`naive.mjs`).
  The current code is safe only because top-level statements get no markers. Add a corpus case, so a future
  "top-level markers" change (needed by B1 if done by markers) doesn't regress.
- **m8. Logical-operand helpers:** `__vto_a/o/n(i, left)` turn every `&&`/`||`/`??` left operand into a call. It is
  semantically safe: `this` is already lost in the original for `(a.b || c)()`, and `#x in o` is checked. The cost is
  measurable in hot loops (selectors over big arrays). Consider inline forms like `(t=left, t||(k[i]=1), t)` with a
  module-scoped temp (watch out for generators/async re-entrancy), or keep the helpers and benchmark.
- **m9.** The `S.active` counter isn't decremented if `onTestFinished` never runs (a timed-out test whose hook
  throws). After that, every test is tainted. Reset it in `beforeEach` when no test is known to be active.
- **m10.** `run-raw.mjs` (v1) appends vto's setup *after* the user's setup files. With the default `stack` order, its
  `afterEach` runs before the user's RTL `cleanup`, so unmount code is lost (p1 `b.test.tsx`). Either align v1
  with v2 (`onTestFinished`, prepend) or drop v1.

---

## 5. Performance (measured)
- **v1 (V8 precise coverage):** 300 React/RTL/jsdom render tests take 505–519 ms for the test file without the
  collector and 4828–5025 ms with it, i.e. **about 1.7 → 16 ms per test (+14.5 ms, ≈10×)**. Raw output was
  92 KB for one file. This confirms the reason for v2.
- **v2 collection:** `fill(0)` plus an `indexOf`-based scan over all registered arrays takes **≈0.19 ms/test at
  150k blocks** and **≈0.29 ms/test at 900k blocks** (a naive loop takes 0.3 / 1.1 ms). Keep `indexOf` (it's
  memchr-backed). Optimisation if needed: a per-file "dirty" byte set by the function-entry marker
  (`k[0]=1` is already there for most files), so untouched files are skipped without scanning.
- **v2 extra per test:** one `setImmediate` tick in `onTestFinished` (≈µs–0.1 ms), plus JSON.
- **Marker cost:** byte stores are negligible. The logical helpers are the only real call overhead (m8).
- **Startup:** oxc parse and magic-string at around 1–3 ms per file is paid once. `fsModuleCache` (default **true** in
  Vitest 5.1) caches instrumented output keyed by plugin name. The plugin name carries a file hash, so plain runs
  never reuse instrumented modules (verified: run4 plain after vto run → no registry). Block tables now live
  in-module (`__vto_blk`), so they survive cache hits. Good. Keep a corpus test that runs twice with a warm cache.
- **Analyzer:** see M9. At 10k tests with the current algorithms, expect seconds, dominated by JSON parsing.
  Output size is the risk.

## 6. Instrumentation syntax review (summary of what I checked against `instrument()`)
- **OK** (`adv.mjs` + `selftest.mjs`): unbraced if/else/loop bodies (wrapped in braces), labels with `continue label`,
  directive prologues (function and module), `using`, `let` after a compound statement in `case`,
  `a?.b || c` then `?.()`, getters with `??`, JSX conditional children, `<T,>` generic arrows, `satisfies`,
  `#x in o`, `export default` conditional, `await`/`yield` in operands, class fields, static blocks, parameter
  properties with `super()` (p3 `cls.test.ts` passes), abstract/declare/overloads skipped.
- **oxc-parser JS spans are UTF-16** (verified with `"Uložit 😀"`), which matches magic-string. If any Rust-side code
  ever re-parses with Rust oxc, those spans are **UTF-8 bytes**. Convert, or Czech text in JSX will shift blocks.
- **Broken:** B3 (circular imports) and M6 (plugin order).
- **Unknown, to add to the corpus:** `vi.mock` partial mocks with `importOriginal` (the original module is
  instrumented, so hits come from the original's internals); `import.meta.hot` guards; files loaded with a query
  suffix (`?worker`, `?inline`) that share a registry key with the plain id; decorators in nested blocks;
  `export =` / `import x = require()` in `.cts`.

## 7. How to validate precision and recall independently
1. **Differential coverage oracle.** Two mechanisms already exist: v1 (V8 block coverage) and v2. For the same run,
   map each v2 block's start offset through the source map into the V8 script and check
   `hit_v2(block) ⇔ V8 count>0 at that offset`. Any disagreement is a bug in one of them. Run it on a real
   app, not only the corpus. A third, unrelated oracle: StrykerJS `coverageAnalysis: "perTest"` (Babel-based
   instrumentation, Vitest runner).
2. **Mutation ground truth for "redundancy".** Run Stryker with the Vitest runner to get the kill matrix
   (test × mutant). A test is *mutation-redundant* if its killed set ⊆ the union of the remaining tests.
   - Precision of vto candidates is the share of flagged tests whose removal leaves the mutation score
     unchanged.
   - Recall is the share of mutation-redundant tests that vto flags.
   - Report both per verdict tier (M5). This quantifies how wrong "coverage-equal" is, and how much DOM and
     assertion fingerprints help.
3. **Fault injection for `affected` (safety is the requirement).** For each Stryker mutant, or a random
   AST-level edit:
   - build the map at the base;
   - apply the mutant as a diff;
   - require every test that fails on the mutant to be in `vto affected` (or exit 3).
   - Target 100 % recall. Report misses by construct type. B1 and B2 will show up immediately.
4. **Historical replay.** Pick 3 OSS React + Vitest repos of different sizes. For N consecutive commits, map at the
   parent, select, then run the full suite at the commit. Count failing tests that weren't selected (must be 0)
   and the selection ratio vs `vitest related`.
5. **Metamorphic invariants:** shuffle seeds, `isolate` true/false, `pool` threads/forks, `--shard`, warm/cold
   `fsModuleCache`, and Windows vs Linux CI. Verdicts must be identical apart from units flagged
   order-dependent, leaky or tainted.
6. **Blind fixtures.** Have someone *not* writing the collector (a separate agent with only FORMAT.md, or a human)
   write fixtures and expected verdicts *before* running vto. Seed them with this review's cases: p1, p3, p5,
   `adv.mjs`.

---

## Prioritized action list
1. **B3**: switch markers to the hoisted getter `(__vto_k||__vto_i())[i]` and add a circular-import corpus case. *(small, user code crashes today)*
2. **B1 + B2**: record per-test-file module deps and import-time hits, and map changed lines by enclosing statement/decision. Make `--broad` the default until fault injection (§7.3) passes. *(`affected` is unsafe today)*
3. **B4**: reword the report (no "removable"/"bezpečná úspora"). Make the minimal set a statistic only, give no-coverage tests their own "nelze vyhodnotit" section, and exclude failed, tainted and leaky units.
4. **M3**: force `maxConcurrency:1`, fix taint to cover all overlapping tests, and honour `tainted` in the analyzer.
5. **M1**: late-hit detection (collect before reset in the next `beforeEach`) and a `leaky` flag.
6. **M7 + M8**: unit = (file, name, line); always `includeTaskLocation`; carry state, skip, retry and taint.
7. **M6**: force first position plus an original-source check; handle the React Compiler explicitly; add an auto-import corpus case.
8. **M5**: DOM fingerprint plus assertion fingerprint (setup file), and static test features (oxc on test files). Introduce verdict tiers.
9. **M4 + M2**: separate setup and body phases, IDF weighting, and an optional shuffle pass for order-dependent atoms.
10. **M10 + M11 (paths)**: rule table for non-code files, Vitest module-graph fallback, per-file content hashes, vto runs `git diff` itself (quotePath, prefixes), case-folded file interning on Windows.
11. **M9**: intern and compress hit lists, cap subsumed/near outputs, cluster.
12. **M11 (distribution)**: per-platform npm binaries built on native runners (static CRT) plus a WASI fallback, and a Windows CI job running the corpus.
13. **§7**: differential V8↔v2 check, Stryker kill-matrix ground truth, fault-injection recall gate, blind fixtures.
