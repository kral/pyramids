# vto – architecture and code-quality review 2

Reviewer: independent principal engineer (did not write the code). State reviewed: git `e6598d9` (clean tree),
2026-11-21. No product code was changed. Scratch work and reproductions: `/home/claude/review2-arch/`.

Evidence tags: **[R]** reproduced in this review, **[C]** read in the code (file:line given), **[D]** measurement
documented in the repo (source given), **[E]** estimate, **[U]** plausible but unverified (mostly Windows/macOS,
which no one has run yet).

Effort: **S** ≤ 2 days, **M** 3–8 days, **L** 2–4 weeks (one engineer who knows the code).

---

## 0. Verdict

The pieces work on Linux and the measured wins are real (selection: −88 … −98 % CPU per edit; vm-guard: −41 … −87 %
CPU per full run). The project is not close to a 1.0 that a company can roll out on Windows, for four reasons:

1. **Two silent-wrong-answer bugs were found by reading the code and both reproduce** (§0.1). A tool whose
   promise is "safe selection" cannot ship with a known path where a failing test is not selected and nothing
   warns.
2. **The Vitest coupling grew instead of shrinking.** ARCHITECTURE.md counted 25 non-public touch points in 9
   files and asked for one adapter. There are now **44 in 20 files**, and the "create Vitest, then mutate the
   resolved config" block exists in three copies (§1).
3. **Every contract has several hand-written readers and writers that already disagree** (§2): three raw
   readers with three file-selection rules, two writers of `env.json` with different merge rules, three
   definitions of "content hash", two stored-map formats.
4. **Nothing has run outside Linux**, the CI workflow has never executed, covers 2 of 6 packages, and one
   package cannot run its tests from a clean clone (§4).

The scope is also wider than the evidence supports. About a quarter of the code (V8 engine, verify, group lanes,
task queue, classic-reporter measurement) has either negative or no measured value (§6). Cutting it first makes
every other item on the plan cheaper.

### 0.1 New defects found in this review

| # | sev | defect | evidence |
|---|---|---|---|
| N1 | **critical** | **Project root reached through a symlink (or any spelling that differs from the real path) → silent recall miss.** `fileload.modules` loses every non-instrumented module (JSON, CSS, barrels), and vto's own setup files get instrumented and recorded as project sources. | **[R]** `work/fx` (real path) vs `work/fxlink → fx2`: after editing `src/data.json` so that `test/data.test.ts` fails, `vto-daemon affected --root …/fx` answers `count 1`, the same with `--root …/fxlink` answers `{"count":0,"runAll":false}`. Cause: `collector/setup-v2.mjs:181` `if (!f.startsWith(ROOT) …) continue;` compares Vite's real-path module ids against `VTO_ROOT`, which is only `path.resolve`d (`mcp/src/engine.mjs:30`, `collector/run-raw.mjs:31`). The same string compare decides the setup-file exclusion (`collector/plugin.mjs:294`). The documented MCP config passes `--root ${CLAUDE_PROJECT_DIR}` (`mcp/examples/mcp.json`), so the root spelling is whatever the client gives. **[U]** On Windows the same mechanism is triggered by drive-letter case (`c:\` from an IDE terminal vs `C:\` from `realpath.native`), junctions, `subst` drives and 8.3 names: line 181 is case-sensitive even on win32 (the `rel()` helper two lines above folds case, which hides the problem in the paths that do get written). |
| N2 | high | **An uninstrumented ("clean") run marks every passing test dirty**, so the next `affected` selects the whole suite. The agent loop recommends a clean run before finishing. | **[R]** fixture, no edits: `affected` → 1 of 9; `vto-daemon run --full --clean`; `affected` → **9 of 9**. Cause: `mcp/src/engine.mjs:376` `if (!isMain) this.fixLaneResults(run, done)` treats the `clean` lane like the `fix` lane, and `fixLaneResults` sets `dirtyTests[id] = 1` for every passed id (`engine.mjs:468`). |
| N3 | high | **`vto affected --git` loses block-level precision for every changed file when Git converts line endings** (`core.autocrlf=true`, the Git for Windows default). | **[R]** `work/crlf/lf` vs `work/crlf/crlf`, same edit: LF checkout selects 1 of 2 tests; CRLF checkout prints `base content differs from the recorded hash (stale map) → every test file importing it` and selects 2 of 2. The collector hashes the text Vite loaded (`collector/plugin.mjs:259`), the analyzer hashes the git blob (`analyzer/src/main.rs:503-513`). Reproduced on Linux with a hand-written raw dir carrying the hash of the CRLF working file; the collector itself was not run on Windows. Fail-safe, but on the primary target platform it turns the CLI path into `vitest related`. The daemon is not affected: it uses a third hash, sha1 of BOM/CRLF-normalised text (`mcp/src/platform.mjs:58`). |
| N4 | high | **`.vm-guard/run/env.json` has two writers with different rules; the daemon erases vm-guard's sticky "DOM miss" evidence.** | **[C]** vm-guard ranks entries `miss` > `probe` > `static` and never lets `dom:true` go back to `false` (`vm-guard/src/auto.mjs:65,81-84`). The daemon overwrites any entry with its own probe result and drops `miss`, `by`, `via` (`mcp/src/classify.mjs:48-52`). The comment at `auto.mjs:63-64` assumes the other producer preserves it. Both do unlocked read-modify-write; the atomic rename prevents torn files, not lost updates. The two static classifiers also differ (`classify.mjs:18-25` vs `auto.mjs:31-51`), as do the DOM environment sets (`'browser'` only in the daemon) and the default node-group pool (`forks` in `engine.mjs:81`, `shared` in `auto.mjs:165`). |
| N5 | med | **Stale-lock race in `engine.lock`.** A process that saw a stale lock unlinks whatever is there on its second pass, including a lock a competitor just created. | **[C]** `mcp/src/engine.mjs:61-72`: `unlinkSync` at :69 is unconditional. Two MCP calls starting stateless engines after a crash can both own `.vto/`. Liveness is PID-only, so PID reuse (frequent on Windows) gives a false `E_LOCKED` until the file is deleted by hand. |
| N6 | med | **The daemon map is keyed by exact-case absolute paths; the case-folding helper is dead code.** | **[C]** `pathKey`/`isCaseInsensitiveFs` (`mcp/src/platform.mjs:26-49`) are unit-tested but `pathKey` has no caller; `isCaseInsensitiveFs` is used only for the endpoint key (`ipc.mjs:46`). `store.mjs:78` writes absolute `file` paths, `state.files` is keyed by them. Consequences: a client that spells a path differently (VS Code reports lower-case drive letters) gets "no coverage"; `.vto/` cannot move between checkouts, so the SAVINGS.md advice to keep `.vto/` in the CI cache only works when the agent work directory is identical (Azure Pipelines agents use `_work/1/s`, `_work/2/s`, …). |
| N7 | med | **Node version floors are wrong.** `collector/setup-v2.mjs:14` calls `process.getBuiltinModule` unguarded at module top level (Node ≥ 22.3 / 20.16) while the root package declares `node >=20`; vm-guard uses `path.matchesGlob` (`auto.mjs:24`, `safety.mjs:37`; Node ≥ 22.5, experimental) and declares `>=22`. | **[C]** Loud failure, but in the user's test run. |
| N8 | med | **vm-guard cannot run its own tests from a clean clone**: no `devDependencies`, no lockfile, `vitest` is only a peer. Its end-to-end tests then report `SKIP vitest not installed`, which would be a false green in CI. | **[R]** copy in `work/vm-guard`: 19 tests → 6 pass, 9 fail (`Cannot find package 'vitest' imported from src/sequencer.mjs`), 4 skipped. The committed `setup.bundle.mjs` is fresh (rebuilt and compared), but no CI job checks that. |
| N9 | low | `fs` read tracking does not resolve `..` (`setup-v2.mjs:125` removes only `/./`), so `readFileSync('tests/../src/x.css')` records a path that never matches a diff. `store.load()` parses every map line without `try` (`store.mjs:52,63`): one truncated line stops every engine start. `FORMAT.md` says `file.hash` is SHA-1; the code writes the first 16 hex of SHA-256 (`setup-v2.mjs:66`), and no reader uses the field. `verify/signals-setup.mjs:15` writes `s-<pid>-<tid>.jsonl`, the prefix FORMAT.md reserves for stored maps. Analyzer `paths::normalize` collapses a UNC root `\\srv\share\p` to `/srv/share/p` (`paths.rs:22-49`), which `git -C` then cannot open → permanent run-all for projects on a share **[U]**. | **[C]** |

### 0.2 What happened to the findings of ARCHITECTURE.md

The git history starts after that review (`8ee1310`, 12 commits), so this is judged from the code.

| finding (ARCHITECTURE.md) | status now |
|---|---|
| C1 format version | done, twice: `version: 2` and `formatVersion: "2.1"` (`run-raw.mjs:135`); the analyzer reads only `version` and infers 2.1 from the presence of `meta.root` (`raw.rs:395`) |
| C2 `meta.setupFiles` | done (`run-raw.mjs:134-137`) |
| C3 relative paths | done in collector output; **not** in the daemon map (N6) |
| C4 content hash, dirty flag | done, but three incompatible hash definitions (N3) |
| C5 hit interning, C6 one persisted map | open; there are now two stored forms (`vto pack` file, `.vto/map/` directory) |
| R1 CI, non-Linux runs | workflow written, **never run**, 2 of 6 packages (§4) |
| R2 / §4.2 adapter, probes, honest peer ranges | **not started; coupling grew 25 → 44** |
| R4 exit-listener leak in vm pools | fixed (`setup-v2.mjs:47-53`) |
| R7 verify rewrites `task.result` | open (`verify/setup-verify.mjs:72`) |
| R8 packaging | open (§4) |
| R9 language | English default done; Czech strings remain in `verify/verify.mjs:172,174`, `verify/mutate.mjs:290`; `analyzer/src/report.rs:1` still says "report.md (Czech)" |
| R11 IPC security | done (private dir, token, random pipe name) |
| R12 bundle freshness | bundle is fresh today; still no check |
| R13 licence | open |
| R14 product tests | Rust: still 0 unit tests in `raw.rs`, `report.rs`, `main.rs`, `model.rs`; mcp 26 unit tests pass **[R]**, tui 66 pass **[R]** |
| ADR-2 WASM default, `vto serve`, Rust as the only raw reader | not done; JS readers went from 1 to 4 |
| ADR-7 build stateless first | done (`Engine` runs stateless or in the daemon); the measurement confirmed the prediction (§6) |
| ADR-8 token budgets, redaction, versioned schemas | done |
| vm-guard `projects` support, fs readers, file granularity, run-all sentinel, `.vm-guard` volatility | done (VALIDATION A1–A4, G1) |

---

## 1. Coupling to Vitest internals

### 1.1 Inventory

Class: **I** = internal (untyped global, private field, undocumented behaviour), **S** = semi-public (exported or
typed, but advanced/experimental, or a documented type used in an unsupported way), **P** = public.
Typed/untyped was checked against the `.d.ts` files of Vitest 5.1.1 (`collector/corpus/node_modules/vitest/dist`).
Only I and S entries are listed; plain public API use is summarised at the end.

**collector/**

| # | dependency | where | class | on change |
|---|---|---|---|---|
| K1 | `globalThis.__vitest_worker__.evaluatedModules.fileToModulesMap` (untyped global) | `setup-v2.mjs:175-176` | I | **silent**: `try/catch`; JSON/CSS/barrel modules vanish from `fileload.modules` → recall loss |
| K2 | module ids are absolute real paths with `?query`; compared to `ROOT` by string prefix | `setup-v2.mjs:180-181` | I (behaviour) | **silent** (this is N1) |
| K3 | `globalThis[Symbol.for('expect-global')]` for `testPath`, `assertionCalls` (untyped) | `setup-v2.mjs:170,217`; `setup.ts:98` | I | silent, benign: falls back to `task.file.filepath`; `assertions` null |
| K4 | `ctx._local` to pick a local `expect` (untyped) | `setup-v2.mjs:217`; `setup.ts:98` | I | silent, benign |
| K5 | `globalThis.__vitest_required__.syncBuiltinESMExports()` so that named `node:fs` imports in vm contexts see the wrappers (untyped) | `setup-v2.mjs:154` | I | **silent**: `fileload.reads` goes empty in vm pools → the fs-reader protection (VALIDATION A1) is gone. An empty `reads` array also switches off the analyzer's static fallback (`main.rs:519-533` only falls back when `reads` is absent). The same happens with `VTO_READS=0`: `S.reads` is created before the switch is read (`setup-v2.mjs:150-151`), so `reads: []` is still written |
| K6 | wrapping the shared `node:fs` builtin once per worker and attributing reads to "the current file" | `setup-v2.mjs:106-144,150` | I (pool behaviour) | silent mis-attribution if Vitest ever runs files concurrently in one worker |
| K7 | hook order: first setup file's `beforeEach` runs first, its `onTestFinished` runs last (after `afterEach`, fixture teardown, RTL cleanup); a setup-file `beforeAll` runs after collection | `setup-v2.mjs:167,191,213` | S (behaviour) | **silent** attribution drift (import-time hits land in the first test, unmount effects are lost) |
| K8 | `task.result.state === 'run'` while a test is active; `task.suite` identity; `task.file.filepath`; `task.fullTestName` with own fallback | `setup-v2.mjs:88,197,201,202` | S | silent: wrong `tainted`/`leaky` flags; id mismatch between collector and verify if one side falls back |
| K9 | mutating **resolved** `project.config` between `createVitest` and `start`: `setupFiles.unshift/push`, `includeTaskLocation`, `maxConcurrency`, `sequence.concurrent`, `coverage.enabled` | `run-raw.mjs:107-127` | I | **silent** if configs get frozen or serialised to workers earlier: collector not loaded (then loud: no raw), or concurrency taints everything |
| K10 | `createVitest(mode, cliOptions, viteOverrides, {cliFilters})`, `parseCLI`, error identity `VITEST_FILES_NOT_FOUND` / class name `FilesNotFoundError` | `run-raw.mjs:45,81,95-99,146` | S | loud (cannot start); wrong exit code for "no files" |
| K11 | `project.vite.config.plugins` to assert the plugin is attached | `run-raw.mjs:121` | S | loud (refuses to run) |
| K12 | reordering `config.plugins` in `configResolved` so vto runs before other `pre` plugins | `plugin.mjs:306-311` | I (Vite) | fail-safe: file skipped with a warning (`plugin.mjs:320-326`) |
| K13 | `fsModuleCache` key includes plugin names (so instrumented code is never served to a plain run) | `plugin.mjs:272-274,300`; `verify/plugin.mjs:9` | I | **silent and dangerous**: plain runs execute instrumented or mutant-schemata modules |
| K14 | `configureVitest` plugin hook, `project.matchesTestGlob`, `project.config.setupFiles` by string equality | `plugin.mjs:294-295,303` | S | silent: test or setup files get instrumented (seen in N1) |
| K15 | the `code` Vite hands to `transform` equals the file on disk except BOM/CRLF | `plugin.mjs:320-326` | I (Vite) | fail-safe (skip + warning), but hash semantics drift (N3) |
| K16 | `chai.Assertion.prototype` wrapping, `chai.util.flag` (opt-in signals) | `setup-signals.mjs:47-58` | S | silent: fingerprints empty or wrong |
| K17 | V8 engine: inspector precise coverage plus the Vitest module wrapper prefix / inline source maps | `setup.ts`, `analyzer/src/v1.rs`, `sourcemap.rs` | I | silent offset shifts |

**verify/**

| # | dependency | where | class | on change |
|---|---|---|---|---|
| K18 | third copy of K9/K10, plus `retry`, `bail`, `testTimeout`, `hookTimeout`, `server.fs.allow` | `runner.mjs:22,61-80` | I | as K9 |
| K19 | file task passed as the second argument of a setup-file `beforeAll`; walking `suite.tasks`, `t.type` | `setup-verify.mjs:36-43` | S | loud-ish: nothing planned → "cannot verify" for every pair |
| K20 | runtime mutation of `t.repeats`, `t.retry`, `t.mode = 'skip'` | `setup-verify.mjs:47-50` | I | **silent**: each test runs once, no mutant active, verdict "confirmed redundant" |
| K21 | `t.result.repeatCount` as the attempt index | `setup-verify.mjs:57` | I | **silent**: wrong mutant per attempt → wrong kill matrix |
| K22 | overwriting `t.result.state = 'pass'`, `errors = undefined` | `setup-verify.mjs:72` | I | reporters or exit code see failures, or real failures are masked |
| K23 | chai wrapping, as K16 | `signals-setup.mjs:51-62` | S | silent |

**vm-guard/**

| # | dependency | where | class | on change |
|---|---|---|---|---|
| K24 | `__vitest_worker__.environment.name` (fallback `.ctx.environment.name`) | `src/setup.mjs:41` | I | silent: env `null` → file classified by other evidence only |
| K25 | vm-pool realm layout: Node builtins and copied globals come from the outer realm, `node_modules` is evaluated per context | `src/realm.mjs`, `src/fingerprint.mjs` | I | shims wrong or unnecessary; leak detector false positives/negatives (silent false green is possible) |
| K26 | batching: with `isolate:false` + `maxWorkers:1` all files go to one worker in sequencer order (`groupSpecs`) | `src/sequencer.mjs:1-4` | I | **silent**: planned lane order ≠ execution order → conflict planner and bisection wrong |
| K27 | `vi.resetModules()` resets project modules and keeps `node_modules` cached | `src/setup.mjs:361` | S (documented behaviour) | shared mode slow or unsafe |
| K28 | shape of the `expect` object: statics list, matcher lookup through `Object.getPrototypeOf(expect(0))` chain | `src/setup.mjs:205-232` | I | loud false alarms ("assertion API replaced") or silent blind spot |
| K29 | `vmMemoryLimit` is compared with `heapUsed` after each file; default `totalmem / maxWorkers` | `src/index.mjs:42-60` | I | performance only |
| K30 | `vitest list --filesOnly --json` output; JSON reporter shape `testResults[].assertionResults[]`, `ancestorTitles`; CLI flags `--reporter=json --outputFile` | `src/cli.mjs:75`; `src/runner.mjs:21-37` | S | loud (CLI cannot list or compare) |
| K31 | `task.result.errors` | `src/setup.mjs:90` | S | silent, benign |

**mcp/ (lanes, daemon)**

| # | dependency | where | class | on change |
|---|---|---|---|---|
| K32 | second copy of K9/K10: `setupFiles`, `includeTaskLocation`, `maxConcurrency`, `sequence.concurrent`, `coverage.enabled` | `src/lane.mjs:130-134,152-164` | I | as K9 |
| K33 | mutating `p.config.pool` and `p.config.isolate` on resolved projects; `vitest.config.bail` / `p.config.bail` per run | `lane.mjs:143-150,266-267` | I | **silent**: group lanes run in the user's pool; `bail` ignored |
| K34 | `vitest.watcher.invalidates.add(f)` (untyped) with `vitest.invalidateFile(f)` (typed) driven by `stat` of every `project.vite.environments[*].moduleGraph.fileToModulesMap` key | `lane.mjs:173-201` | I | **silent and dangerous**: the warm lane runs stale module code after an edit and reports old results |
| K35 | measuring "classic" output: `Object.create(vitest.logger, {outputStream, errorStream, console})`, a `Proxy` around `vitest`, `new Reporter({isTTY:false}).onInit(proxy)`, pushing into `vitest.reporters` at run time, exports `DefaultReporter`/`MinimalReporter`/`VerboseReporter`, and the claim that Vitest selects `minimal` for agents | `lane.mjs:209-239` | I | half-loud (`send error`) or silently wrong savings numbers |
| K36 | `project.createSpecification(file, { testNames })`, `runTestSpecifications(specs, allTestsRun)`, `clearSpecificationsCache`, `globTestSpecifications`, `getRootProject`, `cancelCurrentRun('keyboard-input')`, `vitest.state.getUnhandledErrors()` | `lane.mjs:252-272,288` | S (typed "advanced" API) | loud (TypeError) or silent filter loss if `testNames` semantics change |
| K37 | `onTestCaseResult` fires right after each test, not at module end; `onUserConsoleLog` carries `taskId` and may arrive after the result | `lane.mjs:83-113`; PROTOCOL.md §6 ("measured") | S (behaviour) | silent: time-to-first-failure degrades to file granularity; console lines unattributed |
| K38 | `project.config.provide.vmGuard` read back to detect a wrapped config; generated wrapper config calling the user's config function with `{mode:'test', command:'serve'}` | `lane.mjs:58-71,144,163` | S | silent: wrong pool label, vm-guard not applied |
| K39 | env probe: `__vitest_worker__.environment.name`, `Symbol.for('expect-global')` **without** fallback | `src/collector-ext/setup-env-probe.mjs:17,42` | I | silent: no env record → static classification only |
| K40 | config-file name list as the definition of "is a Vitest project" | `engine.mjs:1035-1046`; `tui/src/sources/protocol.ts:124-136` | S | loud |

**tooling (not shipped)**: K41 `evaluatedModules.idToModuleMap` (`analyzer/faultinject/run.mjs:69`), K42 log scraping
(`bench/bench.mjs`), K43 `startVitest` (`collector/corpus/run.mjs:136`), K44 RTL internals for `asyncUtilTimeout`.

**tui/** uses no Vitest API at all. It speaks only `vto-ipc/1` and uses Vitest as its own test runner. This is the
one package with the right dependency direction.

Public API in use and fine as is: `beforeAll/beforeEach/afterAll`, `onTestFinished`, `inject/provide`,
`BaseSequencer`, the `Reporter` interface and `TestCase`/`TestModule` accessors, `includeTaskLocation`,
`@vitest-environment` pragmas, `vi.*`.

Totals: 44 touch points (40 shipped). **Silent failure with a wrong answer as the result: K1, K2, K5, K7, K9,
K13, K20, K21, K26, K33, K34** (11). Three of them (K5, K33, K34) are new since the first review. K2 was noted
there as an untested gap (ARCHITECTURE.md §5, "Monorepos") and is now a reproduced bug.

### 1.2 Adapter and feature detection

One package, `@kral/vto-vitest-adapter`, is the only code allowed to name anything in §1.1. It has two entry
points, because half the coupling lives in the worker.

```
packages/vitest-adapter/
  main.mjs      // runs in the Vitest main process
  worker.mjs    // copied/served into the project, imported by setup files (must stay build-free .mjs)
  probe/        // throwaway project + probe test files
  caps.json     // capability record schema ("vto-caps/1")
```

`main.mjs`

| function | replaces | notes |
|---|---|---|
| `openVitest({root, config, cliArgs, plugins, setupFirst, setupLast, force})` | K9, K10, K18, K32, K33 | Single implementation of "user config + vto additions". Prefer the plugin `config()`/`configureVitest` hooks to inject `setupFiles` and forced options **before** resolution; fall back to post-resolve mutation only when the probe says the hook path does not take, and then read the values back and refuse to run on mismatch |
| `canonicalRoot(p)` | K2, K14, N1 | `fs.realpathSync.native`, upper-case drive letter, NFC. Every package takes its root from here and exports it as `VTO_ROOT` |
| `invalidate(vitest, files)` | K34 | one place; after invalidation, assert through the module graph that the module's transform result is gone, else restart the lane |
| `runSpecs(vitest, specs, {names, bail})`, `listSpecs`, `cancel` | K36 | |
| `streamReporter(handlers)` | K37 | normalises reporter callbacks into vto events |
| `measureClassicOutput(vitest)` | K35 | optional capability, off by default (§6) |
| `capabilities(vitest)` | all | runs or loads the cached probe result |

`worker.mjs`

| function | replaces | notes |
|---|---|---|
| `evaluatedModules()` | K1 | returns `null` (not `[]`) when the global is missing, so callers can tell "none" from "unknown" |
| `currentTestFile()`, `assertionCount(ctx)` | K3, K4, K39 | |
| `syncBuiltins()` | K5 | returns whether the sync ran |
| `testId(task)`, `isRunning(task)` | K8 | one id function for collector, verify and lanes |
| `environmentName()` | K24, K39 | |
| `scheduleRepeats(task, n)`, `attempt(task)`, `suppressFailure(task)` | K20–K22 | or delete with verify (§6) |

**Capability record.** Every probe produces one boolean plus the evidence, stored per `(vitest, vite, node, pool)`
under the user cache dir and copied into the raw `meta` record, so the analyzer and the daemon know what the
data can be trusted for.

| capability | probe (one micro test file each, ≈1 s total, cached) | when false |
|---|---|---|
| `rootIdentity` | an instrumented module's id starts with the canonical root | **refuse to run** (N1 can never be silent again) |
| `configInjection` | the setup file ran first and its `onTestFinished` ran last; `maxConcurrency` read back as 1 in the worker | refuse to run |
| `moduleList` | a JSON import appears in `evaluatedModules()` | `fileload.modules` flagged incomplete → analyzer widens block-less changes to run-all |
| `fsReads` | `import { readFileSync } from 'node:fs'` inside a vm context hits the wrapper | omit `reads` (so the analyzer's static fallback applies) instead of writing `[]` |
| `hookOrder` | a module-level counter is hit at import, in `beforeAll`, in the test, in `afterEach`, in an RTL-style cleanup; assert which record each lands in | refuse per-test attribution; file-level map only |
| `cacheIsolation` | run instrumented, then plain, assert the plain run sees no `__vto_reg` | set a vto-only `cacheDir` / disable `fsModuleCache` for vto runs (perf/RESULTS.md row 16 measured its effect as 0 %) |
| `warmInvalidation` | edit a module between two warm runs, assert the second run sees the new value | daemon falls back to a cold lane per run (measured cost: 0.1–0.8 s, §6) |
| `eagerResults` | a slow two-test file: first failure arrives before the module ends | protocol field `failureGranularity: "file"` |
| `sharedBatchOrder` | three files in a planned order under `isolate:false, maxWorkers:1` log their order | vm-guard `shared` refuses planned lanes, runs `vm` |
| `realmLayout` | `instanceof` across realms, builtin identity | vm-guard quarantines to forks |
| `repeats` | a test with scheduled repeats reports the attempt indexes | verify disabled |

Rule: a capability that protects correctness fails **closed** (refuse, or widen to run-all with the reason in
the output). Only performance capabilities degrade quietly.

**Enforcement.** A lint rule (oxlint `no-restricted-syntax` / `no-restricted-imports`) forbids
`__vitest`, `Symbol.for('expect-global')`, `vitest/node` and `.config.` assignments outside the adapter. A CI
script greps the built packages for the same strings and compares the count with a checked-in number.

### 1.3 Compatibility matrix

Not a full Cartesian product. Run the cheap suite everywhere and the expensive one on the corners.

| | Linux x64 | Windows x64 | macOS arm64 |
|---|---|---|---|
| Vitest 5.1.x (floor, pinned exact) · Vite 8 floor · Node 22 (floor, see N7) | full | full | cheap |
| Vitest 5.latest · Vite 8.latest · Node 22 latest | full | full | full |
| Vitest 5.latest · Vite 8.latest · Node 24 | full | full | cheap |
| each Vitest 5 minor in between · Node 22 | cheap | – | – |
| Vitest `beta`/`next` · Vite latest · Node 24 (nightly, may fail, opens an issue) | cheap | cheap | – |

*cheap* = probe suite + contract tests (§2.4) + collector corpus (90 cases) + unit tests of every package.
*full* = cheap + mcp integration tests on the fixture + vm-guard end-to-end (`vm`, `shared`, `auto`) + fault
injection n = 60 on the analyzer fixture + **path-identity cases**: root through a symlink/junction, root with a
lower-case drive letter, root containing a space and a non-ASCII (NFC and NFD) segment, CRLF checkout.

Pools are a fourth axis for the probe suite only: `forks`, `threads`, `vmThreads`, `vmForks`.

Peer ranges follow the matrix, not hope: declare `vitest >=5.1 <6` and `vite ^8` in every package, refuse outside
the range unless `VTO_UNSAFE_VITEST=1`. Today the root package claims `vitest >=4` (`package.json`) and warns
only below 4 (`run-raw.mjs:47`), while nothing was ever run on 4.x. Whether 5.0 is supportable is unknown until a
matrix row says so.

---

## 2. Contracts between components

### 2.1 Inventory

| contract | version field | spec | writers | readers | contract tests |
|---|---|---|---|---|---|
| **raw records** (`w-*.jsonl`) | `meta.version: 2` and `meta.formatVersion: "2.1"` | `FORMAT.md` (v1 text, then v2, addendum A, 2.1, addendum B, addendum C, in historical order; the first line still names `collector/setup.ts` and `w-<pid>-<threadId>.jsonl`) | `collector/setup-v2.mjs` (file, fileload, test), `run-raw.mjs` (meta), `setup.ts` (v1 script/test), `mcp/…/setup-env-probe.mjs` (`{"t":"env"}`, **not in FORMAT.md**, in `env-*.jsonl`), `verify/signals-setup.mjs` (`{"t":"sig"}`, in `s-*.jsonl`) | Rust `raw.rs`; JS `mcp/src/store.mjs` `readRaw`; JS `verify/verify.mjs:73-100`; JS `vm-guard/src/cli.mjs` `readVto` and `auto.mjs:88-99`; JS `analyzer/faultinject/run.mjs` | Rust: fixture `tests/fixtures/v2` only; no test that the collector's output today matches any reader |
| **stored map, file form** (`vto pack`) | `version: 2`, `stored: true`, `pathBase: "root"` | FORMAT.md addendum B | Rust `store.rs` (block columns zeroed, kinds collapsed to `"b"`) | Rust `raw.rs` (does not parse `stored`/`pathBase`; works because relative paths happen to resolve); `verify.mjs:99` | one Rust round-trip test |
| **stored map, directory form** (`.vto/map/s-*.jsonl`) | `version: 2`, `producer: "vto-daemon"` | header comment of `store.mjs` | `mcp/src/store.mjs` (absolute paths, no hashes, `env` records inline) | `store.mjs`, Rust `raw.rs` | `mcp/test/contract-analyzer.test.mjs` (good: written after bug D1) |
| **daemon state** (`.vto/state.json`, `blobs/`, `runs/*.jsonl`, `metrics.jsonl`, tasks, `config.json`) | `state.version: 1`; the rest none | none | `store.mjs`, `engine.mjs`, `metrics.mjs` | same; `tui/src/sources/file.ts` reads `runs/*.jsonl` | unit tests; a version mismatch **silently discards the map** (`store.mjs:48`) |
| **`vto-env/1`** (`.vm-guard/run/env.json`) | `format` | `mcp/PROTOCOL.md` §9, although the file lives in vm-guard's directory | `mcp/src/classify.mjs`, `vm-guard/src/auto.mjs` | both | none across the two packages; rules differ (N4); extension fields `miss`, `by`, `via` are not in the spec |
| **`vto-ipc/1`** | integer `protocol` in `hello`; `v: "vto/1"` on results | `mcp/PROTOCOL.md` (prose and tables) | `mcp/src/ipc.mjs`, `daemon.mjs`, `api.mjs` (hand validation), `engine.mjs` (event shapes inline in ~15 `publish` calls) | `mcp/src/client.mjs`; `tui/src/sources/protocol.ts`, `ipc.ts`, `events.ts`; `mcp/dev/mock-events.mjs`; `tui/src/mock/daemon.ts` | `tui/test/platform.test.ts:149-164` compares `projectKey` with mcp's, `tui/test/e2e.test.ts:75` runs against mcp's mock; both are **skipped when the sibling directory is missing** |
| **MCP tools** `vto/1` | `TOOLSET_VERSION`, server `version: '0.1.0'` hard-coded (`mcp-server.mjs:52`) | `mcp/README.md` table | zod shapes in `mcp-server.mjs` | agents | token-budget tests in `integration.test.mjs`; the zod shapes duplicate `api.mjs` validators with different limits (page limit 50 vs 200) |
| **report.json** | none | `report.rs:1`: "schema of the Node version" | Rust `report.rs` | `verify/verify.mjs`, `mcp/src/analysis.mjs` | `tests/cli.rs` checks headings and language only |
| **`vto affected --json` / `--vitest` / exit codes** | none | `main.rs` usage text, FORMAT.md addendum C | Rust | `mcp/src/analyzer.mjs`, shell users | contract test above |
| **`vto-ci/1`** | `v` | `mcp/SAVINGS.md` §4 | `metrics.mjs` | CI scripts | none |
| **vm-guard state** (`incompatible.json`, `conflicts.json`, `run/*.json`) | none | README | vm-guard | vm-guard; analyzer ignore rules (`affected.rs` defaults); `mcp` `vm_guard_status` | `vm-guard/test/state.test.mjs` |
| **`VTO_*` / `VM_GUARD_*` environment variables** (≈20: `VTO_RAW_DIR`, `VTO_ROOT`, `VTO_RUN_ID`, `VTO_ENGINE`, `VTO_SIGNALS`, `VTO_READS`, `VTO_ASYNC_TIMEOUT`, `VTO_EXCLUDE_URLS`, `VTO_LANE_OPTS`, `VTO_POOL`, `VTO_BIN`, `VTO_ANALYZER`, `VM_GUARD_MODE`, `VM_GUARD_LANE_FILE`, …) | none | scattered | all | all | none. `VTO_BIN` (`vitest-overlap.mjs:55`) and `VTO_ANALYZER` (`mcp/src/platform.mjs:93`) name the same thing; the two analyzer resolvers have different search rules |

### 2.2 What is wrong with the current shape

1. **No owner per contract.** FORMAT.md is a change log, not a specification. A reader has to replay five
   layers to know what a record looks like. `vto-env/1` is specified in one package and stored in another.
2. **Duplicated parsers already diverge.** File selection alone: Rust takes `w-*`/`s-*` recursively
   (`raw.rs:231-233`), the daemon takes every `*.jsonl` in one directory (`store.mjs:358-362`), verify takes `w-*`
   recursively (`verify.mjs:84`). Bad lines: Rust counts them and forces run-all, the daemon and verify drop them
   silently. Bug V1 (verify could not read 2.1) and bug D1 (analyzer rejected the daemon's file names) are both
   this class, and both were found by an external validation run, not by a test.
3. **Selection semantics are implemented twice.** The daemon computes its own diff against `.vto/blobs`, decides
   file-level changes itself (`store.mjs` `fileLevelChange`, commented "mirrors the analyzer's rule") and
   remaps blocks, then asks Rust for the rest through `vto affected --diff - --allow-stale`
   (`mcp/src/analyzer.mjs:51-56`). Git is driven from two places with different hardening: Rust forces
   `core.fsmonitor=false`, `core.hooksPath`, `diff.external=` (`main.rs:316-333`); the daemon calls plain
   `git` from `PATH` (`mcp/src/select.mjs:15,22,102-110`).
4. **Readers are permissive in the wrong direction.** `raw.rs` deserialises every record into one struct of 25
   optional fields (`Rec`, `raw.rs:20-75`); an unknown `t` is skipped, a misspelled field is ignored. A collector
   that renames `reads` produces a valid-looking map with no fs protection.
5. **Two version numbers for one format**, and the string one is not read by anything.

### 2.3 Single source of truth

```
contracts/
  raw-2.schema.json        // oneOf by "t": meta | file | fileload | test | env | sig ; x-since per field
  map-2.schema.json        // the ONE stored form (= raw-2 + required meta.stored, root-relative paths, hashes)
  env-1.schema.json        // vto-env/1 including miss/by/via and the merge rule as text + test vectors
  ipc-1.schema.json        // methods: params + result; events; error codes   (OpenRPC-style)
  report-1.schema.json     // report.json, gets a "schema": "vto-report/1" field
  cli-1.schema.json        // affected --json, ci-report
  fixtures/
    raw/valid/*.jsonl  raw/invalid/*.jsonl      // each invalid case names the expected rejection
    path-identity.json                          // (a, b, platform) → same | different
    env-merge.json                              // (current, incoming) → expected
    ipc/*.jsonl                                 // recorded sessions
```

Generated from the schemas:

| artefact | how | consumer |
|---|---|---|
| TypeScript types | `json-schema-to-typescript` → `packages/contracts/index.d.ts` | tui (replaces hand-written `events.ts` types), mcp via `// @ts-check` + JSDoc imports |
| MCP tool input schemas and `api.mjs` validation | derive both from `ipc-1.schema.json` (zod from JSON Schema, or validate with ajv and drop the hand validators) | removes the 50/200 limit drift |
| PROTOCOL.md tables, FORMAT.md record reference | rendered from the schemas; prose stays hand-written | docs cannot drift |
| Rust structs | hand-written **typed enum per record kind** (`#[serde(tag = "t")]`, `deny_unknown_fields` off, required fields required), verified against `fixtures/` in `cargo test`. Code generation (typify) is optional; the fixtures are what matters | analyzer |

Contract tests, all in the cheap CI suite:

1. **Producer tests**: run the real collector on the fixture project in each pool, validate every emitted line
   with ajv. Same for the daemon's `.vto/map`, `env.json`, a recorded IPC session, `report.json`.
2. **Reader tests**: every reader loads `fixtures/raw/valid` and must produce the same normalised model (dump as
   JSON, compare Rust vs JS); every reader must reject each `invalid` case the same way.
3. **Cross-version**: the previous release's fixtures stay in the tree; a reader must accept `N-1`.
4. **Never skipped**: the tui↔mcp tests stop using `skipIf(!exists)`; in a workspace the sibling is always there.

Reduce the number of implementations rather than testing more of them:

- One JS reader, `@kral/vto-raw` (≈150 lines), used by the daemon store, verify, vm-guard and fault injection.
- One stored-map form. `vto pack` writes what the daemon reads; the daemon stores root-relative paths (fixes N6).
- One content-hash definition: **SHA-256 of the UTF-8 text after BOM removal and CRLF→LF**, used by the
  collector, the analyzer's base-blob check and the daemon (fixes N3; drop the unused 16-hex `hash`).
- One version field: `meta.format: "vto-raw/2.1"`; readers refuse a higher major and warn on a higher minor.
- One owner of `env.json`: vm-guard (it is in vm-guard's directory and vm-guard works without vto). The daemon
  hands it probe records through an exported `mergeEnvEvidence()` and never writes the file itself (fixes N4).
- One git driver, the hardened one, and one module that turns "what changed" into hunks.
- One client library `@kral/vto-ipc-client` (discovery, auth, framing) used by mcp, the CLI and the tui; delete the
  copy in `tui/src/sources/protocol.ts:45-136`. One mock daemon.

---

## 3. Code quality per package

### 3.1 Size and hot spots

| package | shipped code | largest units | tests | type checking / lint |
|---|---|---|---|---|
| analyzer (Rust) | ≈ 5,550 lines | `affected.rs` 822, `analysis.rs` 702, `v1.rs` 627, `main.rs` 602, `raw.rs` 575, `report.rs` 528 | 39 unit + 11 security + 1 CLI; **0 in `raw.rs`, `report.rs`, `main.rs`, `model.rs`** | compiler; no `clippy`/`fmt` gate, no MSRV |
| collector | ≈ 1,000 lines `.mjs` + 115 `.ts` | `plugin.mjs` 334, `setup-v2.mjs` 238 | corpus of 90 cases (good), `selftest.mjs`; **no unit test of the setup logic** (hook timing, leaky/tainted, fs wrapping) | none |
| verify | ≈ 1,570 lines | `verify.mjs` 519 (script, top-level code, not importable), `mutate.mjs` 359 | none in the repo (evaluation lives in `/home/claude/verify-fixture`) | none |
| vm-guard | ≈ 2,080 lines + 728 generated | `cli.mjs` 449, `setup.mjs` 382, `index.mjs` 264 | 19 `node:test` cases, not runnable from a clean clone (N8) | hand-written `index.d.ts` (38 lines), no check that it matches |
| mcp | ≈ 3,510 lines | **`engine.mjs` 1,050 lines / 58 KB, one class, 55 methods**; `store.mjs` 434, `lane.mjs` 298 | 26 unit tests (pass), integration + contract tests on a fixture | none |
| tui | ≈ 3,240 lines TS | `model.ts` 300, `scenario.ts` 261, `App.tsx` 258 | 66 tests (pass), snapshot + pty e2e | `strict` TypeScript |

`mcp/src/engine.mjs` is the main maintainability risk. One class owns: the `.vto` lock, lane lifecycle and worker
budget, group planning, selection, run queueing and execution, event publishing and persistence, failure
grouping, the fix loop, the task queue, live coverage ingestion, coverage queries, `why_failed`, status and
metrics. The run is an untyped object that some 40 fields are attached to over its life (`startRun` creates 15,
`execute` adds `laneNames`, `pool`, `snapshot`, `live`, `cancelLanes`, `mapUpdated`, `laneMs`, …,
`fixTick` adds `fixBase`, `fixBusy`, `fixSeq`, `onLaneMessage` adds `started`, `testMsSum`). Lines run to 295
characters; 14 exceed 200. N2 is a direct product of this: "not main" was read as "fix" at line 376 because the
lane kinds are strings compared in several places.

Proposed split (after the cuts of §6, so less is moved):

```
engine/
  project.mjs     root, config, lock
  lanes.mjs       LanePool: start/stop/restart, worker budget           (no knowledge of runs)
  runs.mjs        RunQueue + Run class with an explicit state machine   queued → running → done|cancelled|error
  events.mjs      EventBus: publish, persist, replay, topics            (event shapes come from contracts/)
  mapsync.mjs     ingest, live overlay, coverage queries                (wraps MapStore)
  fixloop.mjs     optional
  queries.mjs     why_failed, tests_for, lines_for, status
```

### 3.2 Error handling

- **Empty `catch {}`**: 11 in `collector/setup-v2.mjs` (238 lines), 46 in `mcp/src` (3,510), 84 in `vm-guard/src`
  (2,809 including the bundle), 6 in `tui/src`. Many are correct (best-effort cleanup). The dangerous ones are
  the feature probes, where the catch hides the loss of a safety property: `setup-v2.mjs:154` (K5),
  `:174-184` (K1), `:170`, `setup-env-probe.mjs:42`. These must set a capability flag, not swallow.
- `mcp/src/lane.mjs:26-27`: `uncaughtException` and `unhandledRejection` are logged and the lane keeps running
  in an unknown state. `daemon.mjs:66-67` does the same for the daemon. After an uncaught exception the lane
  should report, finish the current run as `error`, and exit so that the parent starts a fresh one.
- `store.mjs:52,63`: `JSON.parse` of persisted map lines without `try` (N9). `atomicWrite` falls back to a
  non-atomic copy on Windows (`store.mjs:332-335`); a reader in another process can see a half-written file,
  and then hits the unguarded parse.
- `ipc.mjs` `Client.call` has no timeout; a hung daemon hangs the MCP tool call up to the client's own limit
  (the example config sets 3,600,000 ms). The 1 MiB cap is checked only on the unterminated remainder
  (`ipc.mjs:85`), so a single newline-terminated line of any size is parsed.
- Fail-safe paths that are done well and should be kept as the pattern: `mcp/src/analyzer.mjs:51-69` (any
  analyzer problem → run all, with the reason), `raw.rs` integrity list → run all, `rawdir.mjs` (never deletes
  what vto did not create).

### 3.3 Concurrency, locking, cleanup

- **Lanes.** Up to five warm Vitest processes per project (`dom`, `node`, `fix`, `clean`, or `main`), each with
  its own Vite server and worker pool. Only `fix` is closed when idle (`daemon.mjs:61-62`, 5 min). The worker
  budget is split between `dom` and `node` (`engine.mjs:120-128`), but `fix` and `clean` get workers on top, so a
  fix-lane re-run during a main run oversubscribes the machine. No memory figure per lane is recorded anywhere
  in the repo; on a 16 GB corporate laptop this matters more than CPU.
- **Run queues** are per lane name (`engine.mjs:262-266`), keyed `main`/`fix`/`clean`. A `clean` run and a `main`
  run can execute at the same time on the same files with no coordination; both write `state.failing` and
  `dirtyTests`.
- **Fix loop**: a 700 ms poll that hashes every file covered by every still-failing test (`engine.mjs:711-766`).
  `run.fixBusy` guards re-entry but is not released if `lane.run` never resolves (a killed lane rejects, so this
  holds today; it depends on `lane-client.mjs:31-38`).
- **Locks**: `engine.lock` (N5), `start.lock` (30 s staleness), no lock on `env.json` (N4), none on
  `.vm-guard/run/*` when vm-guard CLI and a daemon lane run together.
- **Process cleanup**: POSIX uses process groups, Windows `taskkill /T /F` (`platform.mjs:64-72`). Unverified on
  Windows **[U]**: a daemon killed from Task Manager leaves detached lanes; nothing reaps them on next start
  because the lock check only looks at the daemon PID.
- **Monkey-patching in the user's process**: the collector replaces 21 functions on the shared `node:fs` builtin
  for the life of the worker (`setup-v2.mjs:140-143`) and never restores them. It preserves descriptors, but a
  test that asserts on `fs.readFileSync.name`/identity or mocks `node:fs` now runs in a different world than in
  CI. This belongs behind a capability and in the "what the collector changes" documentation.

### 3.4 Testability and dead code

- `verify.mjs` and `vm-guard/src/cli.mjs` execute at import; nothing in them can be unit-tested without
  spawning. `engine.mjs` can only be tested through a real Vitest run on a fixture (the integration test takes
  the place of unit tests), which is why N2 and N5 have no test.
- Hard-coded developer paths in tests: `/home/claude/demo/node_modules`
  (`mcp/test/contract-analyzer.test.mjs:16`), `/home/claude/demo` as the root in Rust tests. The first one makes
  the contract test **skip** on any other machine unless the fixture has been installed.
- Dead or orphaned: `pathKey` (N6); `file.hash`; `formatVersion`; `VTO_PLUGIN` alternative-instrumenter hook
  (`run-raw.mjs:89-90`, a benchmark aid in the product path that loads an arbitrary module);
  `VTO_HEAP_LOG` diagnostics in the setup file; legacy-map migration for a format that was never released
  (`store.mjs:49-55,94-98`); `samples/demo-raw` (v1 data); the root `README.md` describes three of the six
  packages.

### 3.5 Conventions that differ between packages

| topic | collector / verify / root | vm-guard | mcp | tui | analyzer |
|---|---|---|---|---|---|
| language | `.mjs` (+ one `.ts` setup file) | `.mjs` + hand `.d.ts` | `.mjs` | TypeScript, built to `dist/` | Rust 2024 |
| test runner | custom scripts | `node:test` | `node:test` | Vitest | `cargo test` |
| deps pinning | caret | none declared | exact | caret | caret + lockfile |
| Node floor | 20 | 22 | 20 | 22 | – |
| arg parsing | 4 hand-written parsers (`vitest-overlap.mjs`, `run-raw.mjs`, `verify.mjs`, `vto-daemon.mjs`) + vm-guard's + Rust's | | | | |
| user-facing language | English, Czech remnants | English + `README.cs.md` (434 lines) | English + `README.cs.md` (148) | i18n table | i18n table |
| analyzer lookup | `VTO_BIN`, sibling build, `PATH` | – | `VTO_ANALYZER`, npm package, sibling build; never `PATH` | – | – |
| formatting / lint | none | none | none | `tsc` only | none enforced |

There is no linter, no formatter and no `.editorconfig` in the repository.

### 3.6 JS or TS

Keep plain `.mjs` for everything that is **loaded inside the user's Vitest** (setup files, the Vite plugin, the
vm-guard setup bundle): these are copied into the project and must run without a build step or a loader. For
them add `// @ts-check`, JSDoc types imported from `contracts/`, and `tsc --noEmit --checkJs` in CI.

Move **mcp** to TypeScript. It is the package with the most internal state, it already needs the protocol types
the tui wrote by hand, and the tui proves the build step is acceptable. The engine split of §3.1 is the natural
moment. vm-guard's Node-side code (`index`, `cli`, `plan`) gains less; `checkJs` is enough and removes the
hand-maintained `index.d.ts`.

One oxlint config at the root with the restricted-syntax rule of §1.2, plus `cargo fmt --check` and
`cargo clippy -D warnings`.

### 3.7 Dependency hygiene

- Root `package.json`: `files` lists only `vitest-overlap.mjs`, `collector/`, `FORMAT.md`; the entry script
  needs `analyzer/` and nothing else is reachable. No `scripts` at all, so there is no `npm test` for the
  collector.
- Six `package.json` files, five lockfiles, no workspace. `typescript ^7` in tui, `^5.9` in the corpus.
- `oxc-parser ^0.159` is a 0.x native package with per-platform optional binaries: it is itself subject to the
  corporate-mirror problem discussed in §4.2 (it has a WASM fallback package, which must be listed and tested).
- Rust: `base64` and `sourcemap.rs` exist only for the V8 path. No `rust-version`, no `rust-toolchain.toml`,
  no `cargo deny`/`cargo audit`.
- `@modelcontextprotocol/sdk` and `zod` are pinned exactly, with a lockfile and `npm ci --ignore-scripts` in CI.
  That is the standard the other packages should meet.

---

## 4. Packaging and distribution

### 4.1 State

| item | state |
|---|---|
| layout | six sibling directories, each its own package or no package (`collector/`, `verify/` belong to the root package) |
| versions | everything `0.1.0`, everything `private: true`; nothing publishable |
| Node / Vitest ranges | Node `>=20` (root, mcp), `>=22` (vm-guard, tui); Vitest `>=4` optional peer (root), `>=5.1 <6` (vm-guard), none (mcp, which needs 5.1 APIs) |
| install today | clone the repo, `cargo build --release`, point the MCP config at an absolute path (`mcp/README.md` uses `C:/tools/vto/mcp/bin/vto-mcp.mjs`); tui needs `npm run build` first (`bin/vto-ui.mjs` imports `../dist`) |
| CI | `.github/workflows/vto-ci.yml`: analyzer build + `cargo test` on 5 targets, mcp tests on 3 OS with Node 22. `mcp/README.md` states it "has not run yet". **Not covered**: collector corpus and selftest, vm-guard, verify, tui, any second Node or Vitest version, lint, the bundle freshness check. Actions are pinned by major tag, `dtolnay/rust-toolchain@stable` floats, the Rust toolchain is unpinned. The `macos-13` (Intel) runner label should be checked; GitHub has been retiring Intel macOS images |
| release | none: no workflow, no changelog, no tags |
| licence | none; `pack-analyzer.mjs:22` writes `"license": "UNLICENSED"` into the binary packages |
| SBOM / provenance | none; the binary package records a sha256 that the resolver checks (`mcp/src/analyzer.mjs:25-27`), which protects against a corrupted install, not against a replaced package (the hash sits next to the binary) |

### 4.2 Installing on Windows without Rust

The analyzer's own work is small: 3,174 tests analysed in 45 ms, of which 2.7 ms is analysis **[D]**
(ARCHITECTURE.md §1.2); 1,992 tests in 0.28 s wall, `affected` 143–146 ms median **[D]** (VALIDATION §2, §4).
A 2–3× slower WebAssembly build is still far below anything a user notices next to a test run.

The corporate constraints that matter:

- registry mirrors (Artifactory, Azure Artifacts, Nexus) that strip or lag `optionalDependencies`;
- `npm ci --omit=optional` and `--ignore-scripts` in hardened pipelines (so no postinstall download);
- AppLocker / WDAC / EDR products that block or quarantine unsigned `.exe` files under `node_modules`;
- no admin rights, no compiler.

Recommendation, same direction as ARCHITECTURE.md ADR-2 and still not done:

| tier | artefact | when used |
|---|---|---|
| default | **`@kral/vto-analyzer-wasm`** (`wasm32-wasip1`, run through `node:wasi`), a regular dependency | always available; one file for every OS and CPU, not an executable, nothing for AppLocker to block |
| optional speed-up | `@kral/vto-analyzer-<os>-<arch>` native packages as `optionalDependencies`: `win32-x64`, `win32-arm64`, `linux-x64-gnu`, `linux-x64-musl`, `linux-arm64-gnu`, `darwin-arm64`, `darwin-x64` | picked when present and its hash matches the value compiled into the **JS** package (not the one beside the binary) |
| override | `VTO_ANALYZER=/path` (one variable; drop `VTO_BIN`) | developers, air-gapped installs |

Work needed for the WASM tier **[E]** (not built in this review; the `wasm32-wasip1` target is not installed
here): `rayon` must fall back to sequential iteration, and the analyzer may not spawn `git`
(`main.rs:335-349`). The second point is an architecture improvement in its own right: move git out of the
analyzer into the one hardened JS git driver of §2.3 and give the analyzer only `--diff -` plus `--base-blob`
inputs. Then the WASM and native builds have identical behaviour and the daemon and CLI share one code path.
`node:wasi` needs preopened directories for the raw dir, the project root (read) and the report dir (write);
that is also a real confinement of the analyzer, for free.

`vto doctor` should print which analyzer tier, which Vitest/Vite/Node, the capability record of §1.2 and the
canonical root. It is the first thing support will ask for.

### 4.3 Layout, versions, release

```
package.json                 // npm workspaces, one lockfile, one lint/format config, engines
packages/
  contracts/                 // schemas, generated types, fixtures (private)
  vitest-adapter/            // §1.2 (private at first; bundled into the two published packages)
  raw/                       // the one JS reader (private, bundled)
  vto/                       // published: CLI (one `vto` bin with subcommands), collector, daemon, MCP server
  vto-tui/                   // published or folded into vto as `vto ui` (it adds react + ink to the install)
  vm-guard/                  // published, independent semver, no dependency on vto
  analyzer-wasm/, analyzer-<os>-<arch>/   // generated by the release workflow
crates/vto-analyzer/
```

- Two public version lines: `vto` (JS + analyzer packages always released together, same version) and
  `vm-guard`. Changesets or release-please.
- One user-facing binary. Today there are `vitest-overlap`, `vto` (Rust), `vto-daemon`, `vto-mcp`, `vto-ui`,
  `vm-guard`, and the docs call the TUI `vto ui`, which does not exist as a command.
- Release workflow: tag → matrix build → tests → `npm publish --provenance` through npm trusted publishing
  (OIDC, no long-lived token) → GitHub artifact attestations for the binaries → SBOMs attached to the release
  (CycloneDX from `npm sbom` and `cargo cyclonedx`) → Authenticode signature for `vto.exe` if native Windows
  binaries are shipped at all. Pin actions by commit SHA, pin the Rust toolchain, add `cargo deny` (licences +
  advisories) and `npm audit --omit=dev` as gates.
- Licence: decide before the first colleague installs it. The owner's `kral/tpfs` is `MIT OR Apache-2.0`; the
  same dual licence fits here (Apache-2.0 carries the patent grant corporate legal teams ask for; all current
  dependencies are MIT or MIT/Apache). The employer-IP question raised in ARCHITECTURE.md §6.2 item 7 is
  unchanged and still comes first. Add `LICENSE-*`, `SECURITY.md` (drafted in SECURITY-REVIEW §7),
  `THIRD-PARTY-NOTICES`.

---

## 5. Should the analyzer reuse `kral/tpfs` path code?

Reviewed: `kral/tpfs` @ `8f7eccd` (2026-11-20), `crates/tpfs-core/src/path.rs` (533 lines), `unicode.rs` (928
lines of generated tables), and the confinement code in `fsops.rs`.

What tpfs has:

| tpfs piece | what it does | fit for the vto analyzer |
|---|---|---|
| `normalize(&Path) -> Option<PathBuf>` | lexical `.`/`..` on an **absolute host path** via `std::path` | **no fit.** The analyzer handles `/`-separated *strings recorded on another machine*: a map written on Windows is analysed on a Linux CI runner. `std::path` on Linux does not understand `C:/x`, and `normalize` returns `None` for the root-relative paths format 2.1 is made of. vto's `paths.rs` is deliberately OS-independent string code |
| `canonicalize` (real path without the `\\?\` prefix), `share_root`, `win_api_path` | host file-system identity | the right idea for N1, but N1 is in **JavaScript** (collector, lane, engine). The Rust analyzer never sees the mismatch. In JS the equivalent is `fs.realpathSync.native` |
| `private_dir`, `check_private_file`, Windows ACL code | a directory only the current user can use | relevant to the **daemon's** endpoint directory (Node cannot set a DACL), not to the analyzer. The token already covers that gap. Not worth a native helper for 1.0 |
| confinement: `openat2(RESOLVE_BENEATH\|NO_SYMLINKS)`, `O_NOFOLLOW_ANY`, handle chains on Windows | TOCTOU-safe **writes** under a root | the analyzer reads raw files (already skips symlinks, `raw.rs:222-228`), reads test sources to grep for `fs` (`main.rs:519-533`, result is one boolean) and writes a report directory. It has no multi-step mutation to protect. With the WASM tier, WASI preopens confine it more simply |
| `nfd()` + tables | canonical decomposition for **Latin, Greek, Cyrillic only** | the one piece that addresses a real analyzer gap, see below |

The real path problems in vto, by where they are:

| problem | where | direction of failure | does tpfs code fix it |
|---|---|---|---|
| root spelling vs real path (N1) | JS | **silent miss** | no (JS) |
| case-exact keys in the daemon (N6) | JS | wrong "no data" answers, non-portable state | no (JS) |
| CRLF/BOM in content hashes (N3) | JS + Rust | precision loss | no |
| NFC vs NFD names on macOS | Rust `fold_key` (`paths.rs:58-64`) and JS | **[R]** `work/nfd`: map has `src/čeština.ts` (NFC), git reports the NFD spelling → `"src/čeština.ts: not in the coverage map"` → run all, exit 3. Fail-safe, but selection is dead for that repo until the file is renamed | partly |
| macOS case-insensitive volumes: folding is tied to "root looks like a Windows path" (`raw.rs:455`) | Rust | run all | no |
| UNC roots collapse (N9) | Rust | run all **[U]** | no (tpfs keeps `std::path` prefixes, vto uses strings) |

On Unicode specifically: a normalisation used as an **identity key** must be the same function on both sides of
every comparison. The JS side has full `String.prototype.normalize`. A three-script table on the Rust side would
agree with it for Czech, and silently disagree for Vietnamese, Korean (Hangul composition) or any script
outside the table. For a key, "mostly the same" is worse than "not normalised", because it fails rarely and
silently. The correct pair is `normalize('NFC')` in JS and the `unicode-normalization` crate (or
`icu_normalizer`) in Rust, applied at one point: when a path enters a map or a lookup.

Cost of coupling to tpfs: `tpfs-core` brings `windows-sys`, `rustix`, `crc32fast` and `sha2 0.10` (vto uses
0.11) and an MSRV of 1.89; its public surface is plan/validate/execute, and the path functions are re-exports
of a private module that will move as the file manager evolves (version 0.7.4, five crates). The analyzer
would need none of the transactional machinery. A file manager and a test tool have unrelated release cadences;
a shared crate means every tpfs refactor is a vto release decision.

**Recommendation: do not share code. No dependency, no vendored crate.**

- Fix path identity where it breaks, in JS, with one `canonicalRoot` + `pathKey` module in the adapter, and
  actually use it (N1, N6).
- In the analyzer: add NFC to `fold_key` with `unicode-normalization` (S), make case folding an explicit
  `meta.caseInsensitive` flag written by the collector instead of a guess from the root string, keep UNC
  prefixes.
- **Share test vectors instead of code.** `contracts/fixtures/path-identity.json` (pairs of spellings with the
  expected same/different verdict per platform: drive-letter case, `\\?\` prefix, UNC, 8.3 names, NFC/NFD,
  trailing dots and spaces, case-only renames) can be copied into tpfs's tests and vto's Rust and JS tests. Both
  projects get the benefit of each other's edge cases with no build coupling.
- If, after both projects reach 1.0, the same 200 lines exist in both, extract a zero-dependency `path-identity`
  crate then. Not before.

---

## 6. Simplification before 1.0

Ordered by (code and coupling removed) ÷ (value lost). Every number is from the repo.

| # | cut or merge | evidence | removes | value lost |
|---|---|---|---|---|
| S1 | **Remove the V8 engine (`--engine v8`) from the product.** Keep `v1.rs` only if the differential oracle is actually built; otherwise delete. | +14.5 ms/test, ≈10× slower than v2 **[D]** (ARCHITECTURE ADR-1). Unsupported in vm pools (`run-raw.mjs:120`), which are the pools vto recommends. Stores the transformed source of every covered file in raw data (`run-raw.mjs:138`, SECURITY F11). The oracle it was kept for (REVIEW-1 §7.1) does not exist | `v1.rs` 627 + `sourcemap.rs` 300 + `flatten.rs` 167 + `setup.ts` 115 lines ≈ 20 % of the analyzer; `base64` dep; K17; the v1 half of FORMAT.md; the `mixed v1 and v2` paths in `raw.rs` | a fallback nobody can use with the recommended setup |
| S2 | **Take `verify` out of 1.0** (separate experimental package or branch). | On the real repo, 7 of 10 "confirmed redundant" verdicts were wrong **[D]** (VALIDATION §5); it was unusable out of the box (bug V1). Best pipeline on the team's own labelled fixture: P 0.81 / R 0.52 **[D]** (ARCHITECTURE §1.2). It holds the deepest internals (K18–K23), still rewrites results, has no tests in the repo, and still prints Czech | ≈ 1,570 lines, 6 touch points, the duplicate signals file, the `sig` record kind | a research result that does not yet transfer to data-driven tests |
| S3 | **Remove the daemon's own `dom`/`node` group lanes; let vm-guard `auto` do the split inside one Vitest.** | All-jsdom suite: two lanes **+16 % CPU** on a full run and **+188 % CPU** (5.3 s → 11.6 s) on an edit **[D]** (`mcp/README.md` "One lane vs two lanes"). Mixed suite: −44 % wall, but against one lane with the same worker count only −14 % wall / −5 % CPU, edit "within noise" **[D]**. vm-guard `auto` already implements classification and per-group pools as Vitest projects and measured −32 % CPU on the same repo **[D]** (commit `793fc2a`) | `classify.mjs`, `planGroups`, `ensureGroupWorkers`, `laneGroup`, merged-lane bookkeeping in `execute`/`onLaneMessage`/`mergeDone`, K33, the second static classifier, the second `env.json` writer (N4), the `<project>:<group>` naming in the protocol | nothing measured |
| S4 | **Make the stateless engine the default; start the daemon only when a client subscribes** (TUI, IDE). | "Warm daemon vs stateless: no CPU saving with the forks pool (±5 %, noise)"; with vm-guard "warm vs cold differs by only 0.1–0.8 s wall" **[D]** (`mcp/README.md`). The daemon's real value is streaming: first failure after 1.3 s vs 9.2 s for an edit run, 40.8 s vs 56.7 s mid-suite **[D]** | for agents: no background process, no IPC, no lock contention, no K34 (stale warm module graph is the one daemon failure that gives a wrong answer); the Windows process-tree questions disappear from the default path | 0.1–0.8 s per call |
| S5 | **Drop the `clean` lane as a warm process; drop or postpone the task queue** (`enqueue_task`, `list_tasks`, `claim_task`, `complete_task`). | The clean lane caused N2. A cold uninstrumented run costs the same 0.1–0.8 s. The task queue has no measurement and no user; orchestrating sub-agents is the agent framework's job | a lane, ~60 lines of engine, four IPC methods, four MCP tools, the `task` event | none measured |
| S6 | **Classic-reporter measurement off by default** (`measureClassic`), on only for an explicit calibration run. | It instantiates three Vitest reporters behind a logger clone and a `Proxy` on every run (K35) to feed the savings report. Passing runs: vto 88 tokens vs Vitest's own agent reporter 126 **[D]**; the token saving exists only for failing runs (789 vs 2,721) | K35 from the default path, unmeasured per-run overhead | sales numbers become "measured on calibration runs", which is what SAVINGS.md already says they are |
| S7 | **One collector-overhead claim.** | `mcp/README.md`: "no measurable CPU" (305 vs 308.5 s). VALIDATION: **+9.8 %** full suite, +11.4 % / +11.7 % per project; after the marker work the node project went +7.1 % → +5.2 % **[D]** (commit `e6598d9`). The docs contradict each other | – | – |
| S8 | **Merge duplicates** listed in §2.3: three raw readers → one; two stored maps → one; three hashes → one; two signals files; two analyzer resolvers; two discovery implementations; two mock daemons; two git drivers; four arg parsers → `node:util.parseArgs` | §2, §3 | ≈ 600–800 lines **[E]** and most of the drift bugs | none |
| S9 | **Czech READMEs**: generate from the English ones or drop until 1.0 | 582 hand-maintained lines that must follow every change; default language is English | drift | Czech readers wait |
| S10 | Legacy-map migration, `VTO_PLUGIN`, `VTO_HEAP_LOG`, `samples/demo-raw`, `file.hash`, `formatVersion`, `pathKey` (use it or delete it) | §3.4 | small | none |

**Keep**: the v2 collector and instrumenter with its corpus; `affected` with file granularity and fs reads;
vm-guard `vm`/`shared`/`auto` with quarantine (best evidence in the repo); the MCP server with token budgets and
redaction; the streaming protocol and the TUI; the fix lane (it is the visible feature of "fix while it runs",
but it needs a memory number and should be opt-in until it has one); the overlap report, repositioned.

On the overlap report itself, since it is the original goal: on the real repo all 5 sampled candidates were
correct as coverage findings and **0 of 5 were deletable** **[D]** (VALIDATION §2); coverage-only precision on
the labelled fixture is 0.11 **[D]**. The sections with direct practical value in that validation were the
by-products: "slow tests without unique coverage" (86.5 s of 131.5 s test time) and "unnecessary imports"
(527 modules). For 1.0, lead with those and with `parametric` grouping, call identical/subsumed tiers "review
candidates", and do not spend more engineering on redundancy verdicts until S2's research question is answered.

Net effect **[E]**: roughly 4,000 of ≈ 17,000 shipped lines go away or stop shipping, the touch-point count
drops from 40 to about 30 before the adapter is even written, and four of the eleven silent-failure couplings
(K20, K21, K33, K34 in the default path) disappear.

---

## 7. Plan to 1.0

Dependency-ordered. An item lists what it needs before it can start.

### Phase A — stop the wrong answers (blocks any pilot)

| # | item | needs | effort |
|---|---|---|---|
| A1 | Canonical root everywhere (`realpathSync.native`, drive-letter case, NFC) + fail-closed check "an instrumented module id starts with ROOT" in the collector; regression tests with a symlinked root and a differently-cased root (N1) | – | S |
| A2 | `clean` runs must not touch `dirtyTests`/`failing` (N2); test | – | S |
| A3 | One content hash, BOM/CRLF-normalised, in collector, analyzer, daemon (N3); test with a CRLF checkout | – | S |
| A4 | `env.json`: one merge function owned by vm-guard, daemon calls it (N4); or S3 makes this moot | – | S |
| A5 | Lock: compare-and-delete on stale takeover, store process start time next to the PID (N5); guarded map load (N9) | – | S |
| A6 | Correct `engines` (Node ≥ 22.12 everywhere, or guard the two APIs) and peer ranges `vitest >=5.1 <6` (N7) | – | S |
| A7 | **Make CI real**: npm workspace + one lockfile; jobs for every package on Linux/Windows/macOS; vm-guard gets `devDependencies`; skipped-because-missing counts as failure; bundle freshness; `cargo fmt`/`clippy`; oxlint. Fix what Windows and macOS then show | A6 | M (+ unknown fallout, budget M more) |

### Phase B — decide scope, then build the structure once

| # | item | needs | effort |
|---|---|---|---|
| B1 | Scope decisions S1–S6 with the owner (one meeting), then delete/move | – | S to decide, M to do |
| B2 | `contracts/`: schemas for raw, map, env, ipc, report; golden fixtures; producer + reader tests; one JS reader; one stored-map form with relative paths (N6); one version field | B1, A7 | M–L |
| B3 | `@kral/vto-vitest-adapter` with capability probes; replace the three `createVitest` copies; lint ban on internals elsewhere | B1, A7 | L |
| B4 | Compatibility matrix in CI (§1.3), nightly `beta` row | B3 | M |
| B5 | Engine split (§3.1) and mcp → TypeScript, generated protocol types shared with the tui, `@kral/vto-ipc-client` | B1, B2 | M–L |
| B6 | Git out of the analyzer; one hardened git driver; analyzer NFC + explicit case flag + UNC | B2 | M |

### Phase C — make it installable and defensible

| # | item | needs | effort |
|---|---|---|---|
| C1 | WASM analyzer as the default tier, native optional, `vto doctor` | B6 | M |
| C2 | One `vto` CLI, package layout of §4.3, versions, changesets | B5 | M |
| C3 | Licence + employer IP clearance, `SECURITY.md`, third-party notices | – (start now, it has lead time) | S of work, weeks of calendar |
| C4 | Release workflow: provenance, attestations, SBOM, pinned actions/toolchain, `cargo deny` | A7, C2, C3 | M |
| C5 | Evidence on the real targets: the user's 3,400-test suite on Windows and macOS (full run per pool, 30 edit iterations, fault injection ≥ 500 mutants at file granularity, 200-commit replay), memory per lane, collector overhead; replace the contradictory numbers in the docs | A1–A7, B3 | M–L |
| C6 | Docs: one README per published package, quick start per OS, "what the collector changes in your test process", troubleshooting by capability, CI templates (GitHub Actions and Azure Pipelines) with the fail-open rule and the map-cache trust rule | C2, C5 | M |

### Can wait until after 1.0

VS Code extension; per-test visual output (TODO.md); remote or git-notes map store; hit interning and stable
block keys (raw is 6.9 MB for 1,992 tests **[D]**, fine at this scale); `vto serve`; Jest or browser-mode
collection; the task queue; verify as a product; redundancy-verdict research; a shared `path-identity` crate
with tpfs; Czech documentation.

### Critical path

`A7 → B1 → B3 → B4 → C5` is the long pole: about 8–10 working weeks for one engineer **[E]**, with B2, B5, B6
and C1–C4 fitting alongside for a second person or adding about 6 weeks in sequence. C3 is calendar-bound and
should start today. Phase A alone (≈ 2 weeks including the first Windows fallout) is enough to start a
**read-only pilot of vm-guard** with colleagues: it has the strongest evidence, the fewest couplings, needs no
map and no analyzer binary, and none of N1–N3 touch it.

### Go / no-go for 1.0

- [ ] N1–N5 fixed, each with a regression test that fails on today's code.
- [ ] CI green on Windows, macOS, Linux for every package; no test skipped for a missing sibling or dependency.
- [ ] No `__vitest*`, `expect-global`, `vitest/node` or resolved-config mutation outside the adapter; every
      correctness capability fails closed and is covered by a probe test on the whole matrix.
- [ ] Every contract has a schema, golden fixtures, a producer test and a reader test; one JS raw reader.
- [ ] `npm i -D vto` on a clean Windows machine without Rust, with `--omit=optional --ignore-scripts`, gives a
      working `vto affected` (WASM tier).
- [ ] `affected`: 0 missed failing tests at file granularity on ≥ 500 mutants and a 200-commit replay on the
      user's suite, on Windows.
- [ ] Licence and IP cleared; release has provenance and an SBOM.
- [ ] Documented numbers come from one measurement run per platform and do not contradict each other.

---

## 8. Top 12 findings

| # | priority | finding | section |
|---|---|---|---|
| 1 | P0 | Root path identity is not canonical: a symlinked (or differently spelled) root makes `affected` miss a failing test with `runAll:false` — reproduced | N1 |
| 2 | P0 | A clean (uninstrumented) run marks every passing test dirty; the next affected run is a full run — reproduced | N2 |
| 3 | P0 | Vitest coupling grew from 25 to 44 touch points; 11 fail silently with a wrong answer; the config-mutation block exists three times; no adapter, no probes | §1 |
| 4 | P0 | CI has never run, covers 2 of 6 packages; vm-guard cannot run its tests from a clean clone; nothing has run on Windows or macOS | §4.1, N8 |
| 5 | P1 | Three content-hash definitions; with Git line-ending conversion `vto affected --git` degrades to importer-level selection for every changed file — reproduced | N3 |
| 6 | P1 | `env.json` has two writers with different rules; the daemon erases vm-guard's sticky evidence; two different static classifiers | N4 |
| 7 | P1 | Contracts have no single source of truth: 5 raw readers with 3 file-selection rules, 2 stored-map forms, 2 version fields, undocumented `env`/`sig` records, selection semantics split between Rust and JS, two git drivers | §2 |
| 8 | P1 | `engine.mjs` is a 1,050-line, 55-method class with an untyped 40-field run object; lock takeover race; up to five warm Vitest processes with no memory budget | §3.1, §3.3, N5 |
| 9 | P1 | Daemon map is absolute-path and case-exact; the folding helper is unused; `.vto/` cannot move between checkouts or CI agents | N6 |
| 10 | P1 | Not installable: all packages private, inconsistent Node/Vitest ranges (two wrong), no licence, no release process, no provenance/SBOM; Windows needs Rust or an unsigned exe. WASM as the default tier is still the right answer | §4 |
| 11 | P2 | About a quarter of the code has negative or no measured value: V8 engine (10× slower, unusable in vm pools), verify (7/10 wrong on the real repo), group lanes (+16 %/+188 % CPU on jsdom suites), warm daemon (±5 % CPU), task queue, classic-reporter measurement | §6 |
| 12 | P2 | Do not reuse tpfs code in the analyzer: wrong abstraction (host `std::path` vs cross-OS strings), the real path bugs are in JS, and a three-script NFD table is unsafe as an identity key. Add full NFC on both sides and share test vectors | §5 |
