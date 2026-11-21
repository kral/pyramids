# Vitest 5.1.1 performance lab: React/TSX + RTL + jsdom

Environment: Vitest 5.1.1, Node 22.23, 2 CPU cores shared with other agents. Load average was 3 to 15 for most of the session, then about 0.5 to 4 for the "quiet" (`Q-`) round.

## How it was measured

- **Fixtures** (all copies of `/home/claude/bench-project`, 312 files / 3193 tests, RTL + userEvent + renderHook + vi.mock + fake timers):
  - `base` is the fixture unchanged: light, with no heavy dependencies.
  - `heavy` is `base` changed by `scripts/heavify.mjs` to look like a real app:
    - every component imports 5 components from the `@mui/material` barrel, one `@mui/icons-material/<Icon>` deep import and a `*.module.css`;
    - half of the test files render through `test/test-utils.tsx`, which wraps them in MUI `ThemeProvider` + `CssBaseline`;
    - `setup.ts` imports `@testing-library/jest-dom/vitest`.
  - `heavy-iconbarrel` is `heavy`, but the icons come from the barrel (`import { Delete } from '@mui/icons-material'`). This mistake is common in real code.
  - `heavy-ownbarrel` is `heavy`, but the tests import from our own barrel `src/index.ts` (`export * from` across 38 modules).
- **Subset for the matrix:** `*.1.test.tsx`, which is 39 files / 390 tests (1/8 of the suite). The top variants were then re-run on the **full suite** (312 files).
- **Metric:**
  - **CPU time** is user+sys of the whole vitest process tree (bash `time`), as a median with (min–max) over 3 to 5 runs. This metric stays stable under load (baseline ranged 66–71 s whether load was 3 or 12).
  - **Wall time** was distorted by the other agents during most of the session. The only trustworthy wall times are from the `Q-` round (quiet machine) and are given separately.
  - The confirmation runs (baseline, happy-dom, vmThreads, isolate:false, css, optimizer, deep-plugin) were interleaved A-B-C-…-A-B-C, so n=5.
- **Important:** Vitest 5 defaults to `maxWorkers = availableParallelism() - 1` in run mode, so **1 worker on 2 cores**. Unless a row says otherwise, every variant runs with that default of 1 worker, so CPU time is roughly proportional to wall time.
- Raw data and tools:
  - raw data: `results.tsv`, `logs/`
  - scripts: `scripts/bench.sh`, `scripts/summarize.mjs`, `scripts/prof.mjs`, `scripts/count-modules.mjs`, `scripts/import-reporter.mjs`, `scripts/barrel-to-deep.mjs`

---

## 0. Ranked summary (heavy, subset 39 files, CPU time; baseline 68.4 s)

| # | variant | CPU s (min–max) | Δ CPU | quiet wall s | Δ wall (quiet) | full suite (312 files) | risk / caveats |
|---|---|---|---|---|---|---|---|
| 1 | `isolate: false` (forks or threads) | 5.5 (5–6) | **−92 %** | – | – | **309 / 3193 FAIL** (vi.mock of `api/client` stops applying across files) | **unsafe here**. Module and global state is shared between files. Good only for suites that have been hardened. |
| 2 | happy-dom + optimizer + `vmThreads` + maxWorkers 2 (comboA) | 10.3 (10–10) | **−85 %** | 6.4 | **−88 %** | 65 s CPU / 44 s wall vs 507 s CPU; 5 failures, all pre-existing (see §5) | Combines the caveats of vm pools and of happy-dom. |
| 3 | barrel→deep plugin + `vmThreads` | 9.9 (10–10) | **−86 %** | – | – | with mw2: 59 s CPU / 35 s wall; only pre-existing failures | vm-pool caveats |
| 4 | `pool: 'vmThreads'` (or `vmForks`, the same) | 12.4 (12–13) | **−82 %** | 11.8 | **−78 %** | **65 s vs 507 s CPU (−87 %)**; the same 7 failures as baseline | Memory grows (set `vmMemoryLimit`). Each file gets its own VM context, so `instanceof` checks against Node built-ins / Buffer / Error and some native modules can behave differently. Watch for leaks. |
| 5 | `vmThreads` + maxWorkers 2 | 13.5 | −80 % | 10.4 | −81 % | 73 s CPU / 42 s wall | as above |
| 6 | `deps.optimizer.client` (MUI, emotion, RTL, react) | 45.2 (42–47) | **−34 %** | 37.2 | **−32 %** | – | Pre-bundling (cache in `node_modules/.vite`). Mixed copies of react/react-dom break hooks, so include **react, react-dom and RTL** too. On vm pools it adds almost nothing. |
| 7 | jsdom → **happy-dom** | 53.5 (52–57) | **−22 %** | 45.5 | −17 % | – | API differences (layout, some events, `innerText`, CSS). Here 390/390 pass. On the light `base` fixture: **−30 %**. |
| 8 | barrel→deep imports (`scripts/barrel-to-deep.mjs`, test config only) | 56.1 (53–59) | **−18 %** | 42.7 | −22 % | – | Low risk. Needs a mapping for the names exported from `@mui/material/styles`. |
| 9 | happy-dom + RTL `defaultHidden` + settings | 50.7 (50–52) | −26 % (vs happy-dom alone: −5 %) | – | – | – | See §3 |
| 10 | `maxWorkers: 2` (= all cores) | 71.3 | +3 % | 39.7 | **−27 %** | – | More RAM. CPU time goes up a little, wall time comes down. |
| 11 | `server.deps.inline: [/@mui/, /@emotion/]` | 65.2 | −6 % | – | – | – | Transform time rises to 10 %. Not worth it. |
| 12 | jsdom + RTL `defaultHidden: true` | 65.7 | −5 % | – | – | – | `*ByRole` stops excluding hidden elements, so tests can change meaning |
| 13 | without the jest-dom import in setup | 67.9 | −2 % | – | – | – | small (~170 ms of import per file; 106 kB / 12 files) |
| 14 | `css: { include: [/.+/] }` (CSS actually processed) | 67.7 | −1 % (noise) | – | – | – | Vitest 5 does not process CSS by default (`css.include: []`). CSS modules cost nothing here. |
| 15 | without `@vitejs/plugin-react` (oxc JSX) | 68.9 | 0 % | – | – | – | transform is only 1 % of the run |
| 16 | `--no-fsModuleCache` | 69.0 | 0 % | – | – | – | The fs cache (on by default) only helps when transform dominates (cold CI / large TS sources). |
| 17 | `pool: 'threads'` (instead of forks) | 70.3 | +2 % | – | – | – | no effect |
| 18 | `--no-file-parallelism` | 70.3 | +2 % | – | – | – | same as 1 worker |
| 19 | maxWorkers 3 (oversubscribed) | 73.6 | +6 % | – | – | – | do not use |
| 20 | `--shard 1/2` + `2/2` as 2 parallel processes | (same CPU) | 0 % | – | – | – | Pays off only across **several machines** (CI matrix). On one machine it is the same as maxWorkers=2 plus a second Vite startup. |
| – | `--changed` (1 component touched) | – | – | – | – | 8 files / 90 tests instead of 312 files (−97 % of the work); touching a context gives 16 files | Needs git. A change to a shared module (test-utils, setup) runs everything. |
| – | `experimental.viteModuleRunner: false` | – | – | – | – | – | **does not work** for `.tsx` ("Unknown file extension .tsx") |

Light `base` fixture (no MUI; baseline 39.7 s CPU):

| variant | change |
|---|---|
| isolate:false | −92 % |
| vmThreads | −84 % |
| comboA | −81 % |
| happy-dom | −30 % |
| optimizer | −7 % |
| threads | −3 % |
| mw2 | 0 % CPU (−7 % wall under load) |

Top-level conclusion: for each test file, Vitest (with `isolate: true`, the default) **re-creates the DOM environment and evaluates the whole module graph again**. With jsdom that is 707 files, plus MUI with 567 files, plus aria-query, user-event and so on. This repeated work is 80 % or more of the CPU time. The tests themselves are 12 %.

---

## 1. Imports, ranked (asked about first)

### 1a. Attribution: what a single worker loads per test file (`scripts/count-modules.mjs`, a `module.registerHooks` preload)

| package | files / test file | kB | note |
|---|---|---|---|
| **@mui/icons-material** (barrel `import {X} from '@mui/icons-material'`) | **10 752** | 6 270 | iconbarrel variant only. CPU +72 % for the whole suite |
| **jsdom** (the environment itself) | **707** | 6 870 | loaded natively for every file. Only vm pools or isolate:false avoid this |
| **@mui/material** (barrel) | **567** | 1 688 | → 212 files with deep imports |
| aria-query (via @testing-library/dom) | 149 | 157 | |
| node built-ins | 148 | – | |
| @mui/utils | 115 | 76 | |
| undici (a jsdom dependency) | 109 | 1 283 | |
| @mui/system | 105 | 184 | |
| @testing-library/user-event | 90 | 180 | |
| vitest | 33 | 831 | |
| @testing-library/dom | 28 | 113 | |
| @exodus/bytes (jsdom) | 27 | 133 | |
| parse5 | 19 | 401 | |
| whatwg-url | 15 | 109 | |
| @testing-library/jest-dom | 12 | 106 | setupFiles |
| pretty-format | 11 | 45 | |
| dom-accessibility-api | 9 | 44 | |
| prop-types | 8 | 36 | |
| react | 7 | 75 | |
| react-dom | 7 | 1 206 | |
| **Total** | **2 292** (iconbarrel **13 042**, deep 1 929, optimizer **1 130**, happy-dom env 1 779) | 14.9 MB | |

Native import cost (fresh `node`, CPU time, median of 3; `heavy/imptime.mjs`):

| import | CPU |
|---|---|
| `@mui/icons-material` (barrel) | **2.1 s** |
| `@mui/material` (barrel) | **0.87 s** |
| 7 deep imports `@mui/material/Box\|Button\|TextField\|Tooltip\|Dialog\|styles\|CssBaseline` | 0.44 s |
| `@mui/icons-material/Delete` | 0.19 s |
| react + react-dom/client | 0.16 s |
| @testing-library/react | 0.15 s |
| user-event | 0.14 s |

Vitest `experimental.importDurations` on a single file shows `@mui/material/index.mjs` with self time 2.47 s (under load), out of 2.60 s total for the file.

CPU profile of a worker (5 jsdom files, `--execArgv=--cpu-prof`, `scripts/prof.mjs`, full output in `profile-jsdom.txt` / `profile-happydom.txt`):

| category | share of worker CPU |
|---|---|
| **Node module loader** (`wrapSafe` CJS compile, `package_json_reader get exports` resolution, `compileSourceTextModule`) | **53 % with jsdom, 60 % with happy-dom** |
| GC | 10–13 % |
| jsdom code (`installInterfaces` 3.4 %) | 13 % |
| happy-dom code | 3 % |
| react-dom | 2 % |
| MUI runtime | 1.5 % |

Top functions: wrapSafe 13 %, `get exports` (package.json exports) 11 %, GC 10 %, compileSourceTextModule 6 %. For comparison, `queryAllByRole` is 2.1 % (jsdom) or 0.8 % (happy-dom) inclusive, and `isInaccessible` is 1.1 %.

### 1b. Ranking of import measures (CPU, subset)

| measure | heavy (MUI barrel + deep icons) | heavy-iconbarrel | base | risk |
|---|---|---|---|---|
| **vm pool** (`pool: 'vmThreads'`): the env and externals are not reloaded per file | −82 % | (not measured) | −84 % | see table 0 |
| **barrel→deep rewrite + vmThreads** | **−86 %** (a further −21 % on top of vmThreads) | | | low |
| `isolate: false` | −92 % | −94 % | −92 % | **breaks vi.mock across files** (full suite: 309 failures; own barrel: 42 failures even in the subset) |
| **deps optimizer (client)** | **−34 %** (quiet wall −32 %) | **−56 %** | −7 % | low or medium (one copy of react) |
| **barrel→deep Vite plugin** (test config only) | **−18 %** (quiet wall −22 %) | **−54 %** | n/a | low |
| icon stub alias (`@mui/icons-material/*` → stub) | 0 % (deep icons are cheap) | **−42 %** | n/a | snapshots / `getByTestId` on icons change |
| `server.deps.inline` MUI/emotion | −6 % | – | – | transform +10 % |
| own `src/index.ts` barrel | **+7 %** (73.3 vs 68.4 s) | | | together with isolate:false it **breaks vi.mock** |
| without jest-dom in setupFiles | −2 % | | | – |

The optimizer helps a lot under `forks`/`threads`, but **almost not at all on vm pools** (vmThreads 12.4 → comboSafe 13.9 with mw2). The deep-import rewrite helps in every pool.

Config snippets:

```ts
// 1) vm pool (largest and safest gain for a suite that keeps isolate:true semantics)
test: { pool: 'vmThreads', vmMemoryLimit: '25%' /* recycle a worker past this heap */ }

// 2) deps optimizer: pre-bundle heavy libs into a few .vite chunks
test: { deps: { optimizer: { client: { enabled: true, include: [
  '@mui/material', '@mui/icons-material/*', '@emotion/react', '@emotion/styled',
  'react', 'react-dom', 'react-dom/client',
  '@testing-library/react', '@testing-library/user-event', '@testing-library/jest-dom/vitest',
] } } } }
// (jsdom/happy-dom are a "client" Vite environment → deps.optimizer.client; `web` is deprecated in Vitest 5)

// 3) barrel → deep imports (tests only), see scripts/barrel-to-deep.mjs
import barrelToDeep from './scripts/barrel-to-deep.mjs';
const styles = Object.fromEntries(['createTheme','ThemeProvider','styled','useTheme','alpha'].map(n => [n, 'styles']));
plugins: [barrelToDeep({ packages: { '@mui/material': { named: styles }, '@mui/icons-material': {} } })]
// It is better to fix the source permanently: ESLint `no-restricted-imports` for '@mui/icons-material' (barrel)
// and MUI's recommended `babel-plugin-direct-import` / a codemod.

// 4) stub irrelevant heavy modules (icons, charts, editors) — test config only
resolve: { alias: [{ find: /^@mui\/icons-material(\/.*)?$/, replacement: fileURLToPath(new URL('./test/stubs/icon.tsx', import.meta.url)) }] }
```

setupFiles: `@testing-library/jest-dom/vitest` costs about 170 ms of import per file, which here is −2 % of the whole suite. Recommendations:
- Keep global setup to the bare minimum.
- Initialise i18n and MSW `setupServer` lazily, or only in the projects or files that need them. Moving a file into a `projects` entry with its own `setupFiles` works for this.
- Under `isolate: true` everything in setupFiles is paid for **once per file**.

### 1c. Checklist: how to find this in your own project

1. Get a breakdown and the hints Vitest 5 prints on its own: `npx vitest run` already prints the `Duration (import X%, environment Y%…)` line and an `Environment … created N times` hint (`experimental.diagnostics` is on by default).
2. Find the heaviest imports:
   ```bash
   npx vitest run --config vitest.imports.config.ts   # experimental.importDurations { print: true, limit: 50 }
   # + reporter scripts/import-reporter.mjs → JSON aggregated over all files (self/total time, how many files)
   ```
3. Count module files per package in a worker:
   ```bash
   MODCOUNT_OUT=/tmp/mc npx vitest run path/to/one.test.tsx --maxWorkers 1 \
     --execArgv=--import=/abs/path/count-modules.mjs
   ```
   Everything over ~200 files per test file is a candidate for deep imports, the optimizer or a stub.
4. Profile CPU:
   ```bash
   npx vitest run one.test.tsx --maxWorkers 1 --execArgv=--cpu-prof --execArgv=--cpu-prof-dir=/tmp/prof
   node scripts/prof.mjs /tmp/prof
   ```
   If `wrapSafe` / `package_json_reader` / `compileSourceTextModule` dominate, the cost is module loading. Use a vm pool, the optimizer or deep imports.
5. Find barrel imports: `rg "from '@mui/icons-material'"`, `rg "from '(\.\./)+(src|components)'"` (own index.ts), `rg "from 'lodash'"`, `date-fns`, `@fortawesome/*`, chart libs.
6. Try `--pool vmThreads` on the full suite and compare the failure list with baseline. Only then consider `isolate:false`, and even then only for a `projects` subset with no `vi.mock`.

---

## 2. Pools and isolation: details

- `isolate: false`:
  - On the subset it is fast (−92 %) and passes, but on the **full suite 309 tests fail**. In `test/data/*` files, `vi.mock('../../src/api/client')` does not apply, because the module is already cached from an earlier file: `TypeError: Cannot read properties of undefined (reading 'then')`.
  - The own-barrel variant fails 42 tests even on the subset.
  - With happy-dom + threads + mw2 (comboB): 269 failures.
  - Recommendation: **do not use globally**. Use it at most in a separate `projects` entry for pure hooks and utilities without vi.mock, and without leftover timers or global stubs.
- `vmThreads` / `vmForks`:
  - They give the same result.
  - On the full suite: CPU **507 → 65 s (−87 %)**, wall 842 → 103 s even under load, with no new failures.
  - Memory: set `vmMemoryLimit`.
  - Known limits:
    - realm differences (`instanceof Error/Uint8Array` against Node API results);
    - modules with native addons;
    - memory leaks in long runs.
- `threads` vs `forks`: no difference (+2 %).
- `maxWorkers`: the default on 2 cores is 1. `maxWorkers: 2` gives −27 % quiet wall (vmThreads 11.8 → 10.4 s). Oversubscribing (3) makes things worse. On a machine with N cores the default is N−1, which is fine.

## 3. happy-dom tuning (items 1–3)

| variant (heavy, subset) | CPU s | vs jsdom baseline | vs happy-dom |
|---|---|---|---|
| happy-dom (default) | 53.5 | −22 % | 0 |
| + RTL `configure({ defaultHidden: true })` | 51.3 | −26 % | −4 % |
| + `environmentOptions.happyDOM.settings` (below) | 52.7 | −24 % | −2 % |
| + both | 50.7 | −27 % | **−5 %** |
| jsdom + `defaultHidden` | 65.7 | −5 % | |

```ts
test: {
  environment: 'happy-dom',
  environmentOptions: { happyDOM: { settings: {
    disableComputedStyleRendering: true,   // getComputedStyle without cascade (affects ByRole hidden checks + toBeVisible!)
    disableCSSFileLoading: true, disableJavaScriptFileLoading: true,
    disableIframePageLoading: true, handleDisabledFileLoadingAsSuccess: true,
  } } },
  setupFiles: ['./test/setup.ts', './test/setup-hidden.ts'],  // setup-hidden: configure({ defaultHidden: true })
}
```

- These settings exist in happy-dom 21.0.4. Others that also exist: `timer.maxTimeout`, `timer.preventTimerLoops`, `navigator.userAgent`, `navigation.*`, `disableErrorCapturing`.
- In v21, loading files (JS, CSS, iframes) is already disabled by default, which is why the settings bring little.
- `defaultHidden: true` changes semantics: `*ByRole` also finds elements that are `display:none` or `aria-hidden`.
- The gain is small because `*ByRole` is only 0.8–2 % of worker CPU, even with 2 207 `ByRole` calls in the suite. The real cost is in module loading.
- **The happy-dom code itself is 3 % of worker CPU.** Top functions: BrowserWindow init, HTMLParser, QuerySelector.querySelectorAll / matches, CSSComputedStyle. An upstream patch would save at most single-digit percentages, so it is not worth it. (Items 4–6 from the coordinator were deferred as agreed. The happy-dom profile is in `profile-happydom.txt`.)

userEvent vs fireEvent (`/home/claude/perf-lab/micro`, 60 tests × (type 11 characters + click), sum of test durations, median of 3):

| | jsdom | happy-dom |
|---|---|---|
| `fireEvent.change` + `click` | 0.87 s | 0.68 s |
| `userEvent.setup()` (default `delay: 0`, one setTimeout per key) | 6.30 s (**7.2×**) | 4.73 s |
| `userEvent.setup({ delay: null })` | 4.87 s (−23 % vs default) | 3.24 s (−32 %) |

Recommendations:
- Set `userEvent.setup({ delay: null })` globally, through your own helper. With fake timers, use `advanceTimers: vi.advanceTimersByTime`.
- Use `fireEvent` for tests that only need a value or a submit and not realistic keystrokes.
- On this suite, tests are only 12 % of CPU, so the effect on the whole suite is a few percent. On suites with many `user.type` calls it is far larger.

## 4. Other measurements

- `--changed`: touching 1 component runs 8 of 312 files (90 tests, 10.6 s user CPU). Touching a context runs 16 files. `--experimental.recordDependencies` + `--sinceLastRun` make this more precise, using the real dependencies of each file.
- `--shard`: this is for parallelism across several CI machines. Two shards on one 2-core machine give no CPU saving.
- `fsModuleCache` (default true): without it, the result is the same here because transform is ~1 %. It matters for a cold CI or large TS source.
- css: by default Vitest does not process CSS, and CSS modules resolve to stable class names. Turning processing on (`css.include`) cost nothing measurable here. With real Sass/PostCSS it would cost more, so keep the default.

## 5. Full-suite validation (312 files / 3193 tests, heavy)

| variant | CPU s | wall s | failures |
|---|---|---|---|
| baseline (jsdom, forks, isolate, 1 worker) | 507 | 842 (under load) | 7 (pre-existing flaky `souběžně`/concurrent tests in the fixture) |
| vmThreads | **65** | 103 (under load) | 7 (same) |
| vmThreads + mw2 | 73 | 42 | 7 (same) |
| deep plugin + vmThreads + mw2 | **59** | **35** | 5 (a subset of the same) |
| comboA (happy-dom + optimizer + vmThreads + mw2) | 65 | 44 | 5 (a subset of the same) |
| isolate:false (jsdom, forks) | 31 | 33 | **309** (vi.mock) |
| comboB (happy-dom + optimizer + threads + isolate:false + mw2) | 32 | 34 | **269** |

## 6. Top 3 recommendations for the user's suite (~3400 tests, >200 s)

1. **`pool: 'vmThreads'`** (+ `maxWorkers` = number of cores, + `vmMemoryLimit`).
   - Gain: −80 to −87 % CPU and wall, while per-file isolation of module state stays in place.
   - Caveat: realm differences (`instanceof`), native modules, memory. Validate by comparing the failure list against baseline.
2. **Get rid of import cost.**
   - Deep imports instead of barrels: icons and MUI, plus your own `index.ts` in tests. Measured −18 % (deep icons) to −54 % (icon barrel), and a further −21 % on top of vmThreads.
   - Or `deps.optimizer.client` with MUI, react and RTL in `include`: −34 to −56 % under forks.
   - Stub irrelevant heavy modules with a test alias.
   - Caveat: the optimizer must also bundle react and react-dom, otherwise there are 2 copies. It brings almost nothing on vm pools. Deep imports help everywhere.
3. **happy-dom instead of jsdom**: −22 % (heavy) to −30 % (light). Add `userEvent.setup({ delay: null })`, which cuts interaction-test time by 23–32 %.
   - Caveat: DOM/CSS API differences. Run the full suite and check for failures that are specific to happy-dom.
   - Tuning (`defaultHidden`, settings) adds only about 5 % more.

Do **not** use `isolate: false` globally. It is −92 % on paper, but it breaks `vi.mock` across files (309 failures on the full suite).
