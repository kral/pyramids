# vto – independent review #2: usability, onboarding, cross-platform

Reviewer: independent agent. I changed no product code and made no commits. Reviewed state: `main` @ `e6598d9`
(2026-11-21 07:47 UTC). Persona: a React/TS developer in a company. They work on Windows, and teammates use
macOS and Linux. Their Vitest suite has about 3,400 tests. They use Claude Code, Cursor and VS Code, and they
want faster tests and cheaper AI-agent iterations.

Method: I followed only the docs (`README.md`, `mcp/README.md`, `vitest-guard/README.md`, `tui/README.md`, and the
`--help` texts) on a fresh `git clone` of the repo and on clean copies of the two test projects. Everything is
reproducible under `/home/claude/review2-ux/`:

| path | what |
|---|---|
| `vto-fresh/` | `git clone` of `/home/claude/vto` @ `e6598d9`, installed exactly as the docs describe. **One local patch** in this clone only: the syntax error in `vitest-overlap.mjs` (F1), so that the walkthrough could continue. |
| `Můj projekt/bench/` | copy of `bench-project` (312 files / 3195 tests). The path has a space and diacritics on purpose. I ran `git init` and committed it as a base. |
| `bench-vmg/` | a second bench copy with vitest-guard installed (symlink, then tarball) |
| `lab/` | `git clone` of the real-world suite (pinned commit), with `node_modules` copied from a prepared lab copy. The original was not touched. |
| `scripts/mcp-client.mjs` | a real MCP client (`@modelcontextprotocol/sdk` `Client` + `StdioClientTransport`). It spawns `vto-mcp` the way Claude Code does. |
| `*.out / *.err / *.time` | raw output of every run quoted below |

Machine: Linux, 2 shared cores, Node 22.23.5, also Node 24.22 and Node 20.20.2 (via `npx node@20`). Rust 1.97 with
a warm crate cache. Load during the runs was 1.5–4.

Severity: **S1** blocks a new user or gives a wrong result without warning · **S2** a new user loses a lot of time or
ends up with a wrong mental model · **S3** friction or a cosmetic problem.

---

## 1. Friction log (fresh-install walkthrough)

### 1.1 Install

| # | sev | step (doc) | what happened | fix |
|---|---|---|---|---|
| F1 | **S1** | `node vitest-overlap.mjs` (README: "user entrypoint") | **The main entrypoint does not parse at HEAD.** `SyntaxError: Unexpected identifier 'is'` at line 12. The JSDoc header contains `findBy*/waitFor`, and `*/` closes the comment. `--help`, `--version` and every run die the same way. `node --check` over all committed `*.mjs` flags only this file. It came in with `e6598d9`, the last commit. CI does not run this file (§2.3), so CI could not catch it. | Change the comment to `findBy*, waitFor`. Add `node --check` for every `.mjs` file and a smoke test of `vitest-overlap.mjs --help` in CI. The `--help` printer also does `split('*/')[0]`, so any later `*/` in the header would truncate the help. Generate the help from a string instead. |
| F2 | S2 | root `README.md` | It is 14 lines long, has no install section, no prerequisites and no quickstart. The install commands exist only in `mcp/README.md` §"Setup for Claude Code". A user who wants only the overlap report never finds them. | Write a root quickstart (§4.2). |
| F3 | **S1** | analyzer | **The Rust toolchain is required and not documented.** No README says "install Rust". `Cargo.toml` uses `edition = "2024"`, which needs Rust ≥ 1.85, but there is no `rust-version` and no `rust-toolchain.toml`. On Windows, `cargo build` also needs the *MSVC Build Tools* (link.exe, about 2–6 GB, and often admin rights on company machines). Prebuilt `@jirikral/vto-analyzer-*` packages are only "planned" and not published. Measured with a warm crate cache: build 38.6 s wall / 55 s CPU. Cold it takes minutes, and it needs crates.io access, which a corporate proxy may block. | Publish the prebuilt binaries first. Until then, document the prerequisites per OS (rustup, plus MSVC on Windows), add `rust-version = "1.85"`, and attach the CI build artifacts to a GitHub release. |
| F4 | S2 | `npm ci --ignore-scripts && (cd mcp && npm ci --ignore-scripts)` | This works: 0.9 s + 1.7 s with a warm cache. The lockfiles contain every oxc/esbuild platform binding (checked), so Windows and macOS installs resolve the right native binding. But there are **5 separate `npm ci`** (root, mcp, tui, test fixture, collector corpus), and vitest-guard has no lockfile and no install step at all. | One workspace (`npm workspaces`) or one package (§4.1). |
| F5 | **S1** | vitest-guard Quick start: `import { defineVitestGuardConfig } from 'vitest-guard'` | **Nothing says how to get `vitest-guard` into the project.** The package is `private: true` and not published. The natural attempt is `npm i -D ../vto/vitest-guard`. npm creates a symlink, and Node resolves `vitest` from the *realpath* (the vto checkout), so every command fails: `ERR_MODULE_NOT_FOUND: Cannot find package 'vitest' imported from …/vto-fresh/vitest-guard/src/sequencer.mjs`. Even `npx vitest-guard --help` fails that way, and running `node vitest-guard/bin/vitest-guard.mjs` from the checkout fails the same way. Only `npm pack` + `npm i -D vitest-guard-0.1.0.tgz` works (verified). | Document the tarball install, or resolve `vitest` from `process.cwd()` / `--root` (`createRequire(root)`) instead of from the module's own location. Print `--help` without importing vitest. |
| F6 | **S1** | vm-guard CLI docs: `npx vm-guard compare …`, `npx vm-guard check …` | **Name collision on npm.** `npm view vm-guard` returns an unrelated public package, *"A safer VM framework"*, v1.1.20. If vm-guard is not installed locally (and F5 makes that likely), `npx vm-guard check` asks to **download and run that foreign package**. With `npx -y`, which is common in CI scripts, it runs without asking. `vto` is also taken on npm (`0.0.0-temp.*`). `vitest-overlap`, `vto-daemon`, `vto-mcp` and `vto-ui` are free today. | Rename before publishing, or use a scope you own (`@<org>/vm-guard`). Never document `npx <unscoped-name>` for a package that is not published under that name. Use `npx --no-install` in docs. |
| F7 | S2 | `tui/README.md`: "Real daemon: `node bin/vto-ui.mjs`" | `ERR_MODULE_NOT_FOUND …/tui/dist/cli.js`. `dist/` is git-ignored, and only the `mock*` scripts build it. You need `npm install && npm run build` first (0.7 s). The README's "Quick start" uses `npm install` (which updates the lock), while every other README uses `npm ci`. | Add a `prepare`/`postinstall` build, or say "`npm ci && npm run build`" explicitly. Better: ship `dist/` in the package. |
| F8 | S3 | Node version | The `engines` fields disagree: root ≥ 20, mcp ≥ 20, vitest-guard ≥ 22, tui ≥ 22. The daemon defaults to pool `auto`, which loads vitest-guard (≥ 22), so "mcp ≥ 20" is not true in practice. Under Node 20.20 the bench project itself fails (`undici … reading 'bind'`, jsdom 31). `vitest-overlap` then still writes an **empty report** ("0 tests … minimal set 0/0") and exits 1, with the real error buried in Vitest's output. | Make it Node ≥ 22 everywhere and check it at startup with a one-line message. Refuse to write a report from 0 tests ("Vitest did not run any test; see above"). |

### 1.2 First runs of every entrypoint

| # | sev | entrypoint | observation | fix |
|---|---|---|---|---|
| R1 | S3 | `vitest-overlap` wrong dir / no Vitest | `vto: cannot find "vitest" from /tmp/emptyproj – run from the project root`, exit 2. **Good.** | – |
| R2 | S2 | `vitest-overlap` first run (bench, path with spaces + diacritics) | It works (`6 m 36 s` wall, `4 m 38 s` user CPU, Vitest's default forks pool, 3174 tests). But there is **no progress indicator of its own**: one line, "running tests (engine v2)…", and in non-TTY mode only Vitest's ` RUN v5.1.1` for 6 minutes. The report is written into the **project** (`./overlap-report/`, 959 KB `report.md` + 3.2 MB `report.json`). That is not in a normal `.gitignore`, so an agent's `git add -A` commits 4 MB. | Use Vitest's progress reporter. Put the default output in `.vto/reports/` (already ignored). Print a "next step" line. |
| R3 | S2 | `report.md` actionability | On bench: **351 identical-coverage groups covering 3024 of 3174 tests**, 2654 "contained", and "tests without unique coverage: 59.98 s (3173 tests)". That is 95 % of the suite flagged, with no ranking a human could start from. The label is misleading: `### Group 1 (4 items, reason: same-coverage)` lists **15 tests** ("items" = covered blocks). Names are HTML-escaped inside Markdown (`sada 1 &gt; title`, `\(varianta\)`), so the raw file and terminals show entities. | Lead with "Top 10 merge candidates" ranked by saved time × confidence. Say "15 tests, 4 covered blocks". Escape only for HTML renderers, or use code spans. Cap `report.md` at a reviewable size and keep the rest in JSON. |
| R4 | S2 | `vto` (analyzer) without args / `vto affected` without raw / `--version` | The whole usage text is printed **with literal `\u{a}` instead of newlines** (`die()` → `sanitize::term` escapes `\n`): one 4,000-character line. `--version` is "unknown option" in `vto`, `vitest-overlap`, `vto-daemon` (the last one reaches `usage(64)`) and `vitest-guard`. | Print usage through a path that is not sanitized (it is a constant). Add `--version` everywhere. |
| R5 | S2 | `vto affected ../nonexist --git HEAD` | `raw data rejected: … No such file or directory` → **exit 3 = "run all"**. A typo in a CI path silently runs the full suite forever, and nobody notices because CI stays green. | A missing or empty `<raw>` is a usage error (exit 2). Keep exit 3 for "the map is valid but cannot answer". |
| R6 | **S1** | `vto affected` after a normal local workflow | Two different things are both called "affected" and behave differently. (a) **Map recorded on a dirty tree** (the usual local case): every later `vto affected` gives `run all: the map was recorded on a dirty working tree`, exit 3. Nothing warns at recording time. (b) **Map recorded at commit A, then you commit B** and run `--git HEAD`: `run all: the map was recorded at 8981f11…, but the diff base is b4f3126… (stale map)`. The message does not say that `--git 8981f11` (the map's commit) would work, which I checked. The daemon (`vto-daemon run-affected` / MCP) has neither restriction: it keeps blobs of the recorded versions. So a user who tries the analyzer CLI first concludes "affected never works". | When recording, print "map recorded on a dirty tree: `vto affected` will run all; commit first or use the daemon". In the stale message, print the exact command (`--git <map commit>`). Long term, one engine (§4.1). |
| R7 | S3 | `vto affected` output | It is good and readable, with a reason per changed file ("insertion after line 50 outside any block (top level) → every test file importing it"). The `--vitest` filters are `./file:line` and work with spaces in paths. But the documented consumer is `… --print0 \| xargs -0 -r npx vitest run`, and that **does not exist on Windows** (PowerShell/cmd have no `xargs`). The pipe also loses exit code 3 without `pipefail`, and BSD/macOS `xargs` behaves differently. | Ship `vto run affected` (it exists as `vto-daemon run-affected`) as *the* documented way. Keep the pipe as an advanced recipe. |
| D1 | S3 | `vto-daemon run-affected` first run (bench) | 63.7 s wall / 47 s CPU, 3195/3195 pass, `[vitest-guard:vm]`. Then an edit → 80 tests in 3.3 s. **Very good.** The first line still says `r1 full: 0 tests in 0 files (run all: no coverage map yet …)` (VALIDATION D2, not fixed). | Fill `total` / `files` at `start_run`. |
| D2 | **S1** | daemon default pool | **It silently changes how the user's tests run.** With the default `pool: "auto"`, the daemon wraps the project config with vitest-guard and runs jsdom files in `vmThreads` with realm shims. The bench config says nothing about pools (= forks). vitest-guard's own README says "the shims make vm more tolerant than forks … only `verify` catches this" (false greens). The only hint is the `[vitest-guard:vm]` tag at the end of a line. A developer whose test passes under vto but fails in CI (forks) has no clue why. | On first use, print one explicit line: "running in vitest-guard `vm` (≈ −80 % CPU); CI should still run forks; `VTO_POOL=config` to keep your pool". Store the choice in `.vto/config.json` written by `vto init`. |
| D3 | S2 | stateless vs daemon pool (the real-world suite) | The first `vto-daemon run-affected` (stateless) ran **one lane `vitest-guard:vm`** for both projects. the real-world suite `node` project is +9 % slower in vm (VALIDATION G2). The daemon then reported `pool: dom:vm+node:forks` and ran two lanes. The same command gives different pools depending on whether a daemon or an `env.json` exists. | Same routing in both, decided from the configured environment (which is already known before the first run). |
| D4 | S2 | agent latency | On the real-world suite, an agent-typical edit (appending `export const __rv = 1;` to `src/core/hash.ts`) → "top level → every importer" → **1420 of 1992 tests, 177 s** for a single `run_affected` call that blocks the agent. Nothing suggests `start_run` + `next_failures` at that point. | When the selection is > N % or the estimate is > 30 s, have `run_affected` return early with `{"suggest":"start_run"}`, or switch to streaming by itself. Treat top-level additions of new declarations (no existing block changed) as "importers that use the new name", not every importer. |
| D5 | S3 | `.vitest-guard/run/` written by the daemon | After daemon runs, the real-world suite clone shows `?? .vitest-guard/run/env.json`, `?? .vitest-guard/run/w-*.jsonl` in `git status`. The `.gitignore` (`*`) inside `run/` is created only by the vitest-guard CLI, not when the daemon or the vitest-guard setup writes there. | Create `run/.gitignore` from whatever code path creates `run/`. |
| M1 | S3 | MCP server via a real SDK client | `initialize` OK, server instructions present and good, **22 tools**. `daemon_status` (627 chars), `affected_tests` (206), `run_affected` green (271 chars) / 26 failures (3312 chars, 5 groups with `alsoIn`, `changed` line). Lazy daemon start works. The output is very good for agents. | – |
| M2 | S2 | MCP setup for Cursor / VS Code | The persona uses Cursor and VS Code, but only Claude Code is documented. `examples/mcp.json` relies on `${CLAUDE_PROJECT_DIR:-.}`. Other clients do not set it, and they start servers with their own cwd, so the root falls back to `.`, which may be the editor's install dir. Then: "Engines refuse to start outside a Vitest project". | Document `.cursor/mcp.json` and `.vscode/mcp.json` (`"servers"` key, `${workspaceFolder}`). Make `vto-mcp` use the MCP `roots` capability when the client offers it. |
| M3 | S3 | `examples/` placeholders | `examples/mcp.json` uses `${VTO_HOME}` (expanded by Claude Code), while `examples/claude-settings.json` uses the literal `<VTO_HOME>`, and the README uses `C:\tools\vto` / `/opt/vto`. Nothing tells the team to set `VTO_HOME` per machine (`setx VTO_HOME …` on Windows). | One placeholder style. Add a "team setup" paragraph. Or remove the need entirely with an npm package (`npx --no-install vto mcp`). |
| H1 | S3 | Claude Code hook | The grammar works as documented. It denies `npx vitest run`, `npm test`, `yarn test` and `npx vitest run src/a.test.ts`, and stays silent for options, quotes, backslash paths and `pnpm exec`. I checked the Claude Code docs: `"args"` (exec form) and the `Bash\|PowerShell` matcher are both supported. Gap: it **denies even when the vto MCP server is not configured or cannot start** (missing analyzer), and denies `npm test` in projects where `test` is not Vitest (e.g. `turbo run test`). The agent then gets a hint to use a tool it does not have. | Have the hook check that `.vto/` exists (the project has been set up) and that `package.json` `scripts.test` contains `vitest`. Otherwise stay silent. |
| U1 | S2 | `vto ui` (README: "`vto ui` (alias `vto watch`)") | No `vto ui` command exists. `vto` is the Rust analyzer. The real command is `node tui/bin/vto-ui.mjs [ui\|watch]`, and there is also an unrelated `vto-daemon watch` (plain text). Against the real daemon during a full run (pty 120×32), the TUI showed 26 failures as they happened, with code frames: **excellent**. With no daemon: `no daemon for /tmp/emptyproj … Start one (npx vto-daemon serve / any vto MCP call)`. `npx vto-daemon` is not a published package, so that advice fails. Without a TTY it falls back to stdin and prints `Source ended without run-end (incomplete run)`, exit 2, which hides the "no daemon" message. | Real `vto ui`. Correct the advice ("`node <vto>/mcp/bin/vto-daemon.mjs serve`" or `vto daemon start`). In non-TTY mode, print the same "no daemon" message. |
| U2 | S3 | TUI / CLI language | The product default is English, but `tui/README.md` is **Czech-first** (the English section is shorter and points to Czech captures). `vto-ui --help` is bilingual and Czech-first ("Použití / usage", "Zdroj událostí / event source"). The TODO mentions a VS Code CodeLens "Zobrazit výstup". | English-first everywhere, Czech in `README.cs.md`, `--help` in the active `--lang`. |
| G1 | **S1** | `vitest-guard check` / `compare` on a config **not** wrapped with `defineVitestGuardConfig` | It **silently measures nothing.** `VITEST_GUARD_MODE` only affects wrapped configs. On `bench-vmg` with the plain config: `vitest-guard check test/cesky` → `[vitest-guard] vm: 16 files, 0 failing`, exit 0, although everything ran in forks. `vitest-guard compare --sample 5` → `forks 5.3 \| vm 5.7 (+8 %) \| shared 5.1 (-4 %) -> recommend isolated (forks)` and **writes `modes.json` = `{"root":"isolated"}`**. After wrapping the same config, `compare --sample 20` → `forks 20.2 \| vm 4.1 (-80 %) \| shared 2.4 (-88 %) -> recommend shared`. A new user who runs the documented "step 0" (`compare`) before editing the config (the README's own order: rollout step 0 comes before step 3) gets the opposite recommendation. | The CLI knows whether the setup ran: wrapped runs log "layer self-time", unwrapped runs do not. If no vitest-guard setup log exists after the run: exit 64, "vitest.config.ts is not wrapped with defineVitestGuardConfig – see Quick start". |
| G2 | S2 | `vitest-guard compare` recommendation | On a 20-file sample it recommends **`shared`**, the mode the same README calls "opt-in until verify has been clean for a while". The tool recommends the riskiest mode as its headline. | Show "recommended for CI: vm; fastest: shared (needs `verify --mode shared --sample all` clean)". |
| G3 | S3 | `vitest-guard scan` on a clean project | No output at all, exit 0. | "scan: 0 shared-mode risks in 312 files". |
| G4 | S3 | vitest-guard docs vs CLI | `--help` says `plan … -> .vitest-guard/plan.json`, but the README says volatile files (`plan.json`) live in `.vitest-guard/run/`. The `--help` header lists `<check\|verify\|plan\|run\|hunt\|scan\|report>` without `compare`/`calibrate`, which are listed below it. `files` in `package.json` lists `README.md` twice and omits `README.cs.md`. Config discovery knows `vitest.config.{ts,mts,js,mjs}` and `vite.config.ts`, but not `vite.config.{mts,js,mjs}` or `vitest.workspace.*`. | – |
| V1 | S3 | `verify/verify.mjs --help` | `vto verify: unknown option --help`. The docs call it "`vto verify`", but it is `node verify/verify.mjs` and has no README. | – |

### 1.3 Common mistakes tried

| mistake | result | verdict |
|---|---|---|
| wrong dir / not a Vitest project (`vitest-overlap`) | clear message, exit 2 | good |
| wrong dir (`vto affected`, no git) | `run all: cannot resolve base: git rev-parse: fatal: not a git repository`, exit 3 | acceptable; "not a git repo, use `--diff`" would be better |
| `vto affected` without `--git` | `exactly one of --git <base> or --diff <file\|-> is required`, exit 2 | good |
| typo in raw path | exit 3 "run all" (R5) | **bad** |
| dirty tree when recording | silent, then every `affected` = run all (R6) | **bad** |
| stale map (new commit) | run all, no hint which base to use (R6) | **bad** |
| subset recorded (`-- test/cesky`), edit outside | `not in the coverage map` → run all | good (safe) |
| wrong Node (20) | the project breaks, the report is empty but still written (F8) | bad |
| Vitest `projects` (the real-world suite) | collector and daemon handle both projects (1992/1992). The stateless and daemon pools differ (D3). | ok |
| vitest-guard not wrapped | false "ok" and an inverted recommendation (G1) | **bad** |
| vitest-guard installed by local path | cannot start (F5) | **bad** |
| TUI before build / without daemon | module-not-found / wrong advice (F7, U1) | bad |

---

## 2. Cross-platform

### 2.1 Platform risk table (code review + simulation)

"Sim" = simulated on Linux. "Code" = found by reading the code. Nothing was run on real Windows or macOS (neither
by me nor by CI so far, §2.3).

| # | platform | area | finding | evidence | risk | fix |
|---|---|---|---|---|---|---|
| W1 | Windows | collector `fileload.reads` (VALIDATION A1 fix) | `setup-v2.mjs:120,123` turns `file:` URLs into paths with `decodeURIComponent(new URL(..).pathname)`. On Windows that gives `/C:/proj/src/x.css`, which starts with `/` and fails `startsWith('C:/proj/')`, so the read is **dropped**. `readFileSync(new URL('../src/x.css', import.meta.url))` is *the* common pattern in guard tests, so the fs-reader recall fix (`typeScale`, `no-math-random`) does not work on Windows. | code | **high** (silent recall loss) | `fileURLToPath()` |
| W2 | Windows | collector `fileload.modules` | `setup-v2.mjs:181` filters `fileToModulesMap` with a **case-sensitive** `f.startsWith(ROOT)`, while lines 27 and 126 compare case-insensitively on Windows. A lower-case drive letter (`c:\…` cwd from some VS Code tasks, Git Bash, `cd /d c:\x`) against Vite's `C:/…` ids gives an empty `modules` list. That is the "silent recall loss" ARCHITECTURE V1 rates **high**. | code | **high** | use the shared `rel()` / case-folded compare. Normalize the drive letter with `slash()` as `mcp/src/platform.mjs` does. |
| W3 | Windows/macOS | ROOT = `process.cwd()` (not realpath) | `subst P: C:\long\path`, directory junctions, OneDrive-redirected folders and mapped drives make Vite resolve ids to the real path while ROOT stays `P:/`. Everything is filtered out. The same happens on macOS with `/tmp` → `/private/tmp` and symlinked workspaces. `mcp/src/ipc.mjs projectKey()` also uses `path.resolve` without realpath, so two daemons can start for one project, and then "only one engine may own `.vto/`" errors. | code | med | `realpathSync.native(root)` once, everywhere |
| W4 | Windows | user profile paths | Company usernames such as `C:\Users\Jan Novák\…` (space + diacritics) or 8.3 short names (`JANNOV~1`) appear in `%LOCALAPPDATA%` (daemon endpoint) and `os.tmpdir()` (raw dir, vitest-guard `mkdtemp`). The Linux run with `Můj projekt/` worked for every entrypoint, but short-vs-long-name mismatches cannot be simulated here. | sim (Linux part ok) | med | realpath (W3); include such a path in the CI matrix |
| W5 | Windows | Git Bash (mintty) | Node sees `isTTY=false` under plain mintty (not Windows Terminal), so `vto ui` drops into CI mode, and `--stdin` + keyboard needs `CONIN$`. The README's `claude mcp add … node C:\tools\vto\…` loses its backslashes when typed into Git Bash. | code/known | med | detect mintty (`TERM_PROGRAM=mintty`, `MSYSTEM`) and say "use Windows Terminal or `winpty`". Use forward slashes in every doc example. |
| W6 | Windows | `xargs` pipeline | not available in PowerShell/cmd (R7); Azure/GitHub Windows agents default to `pwsh` | doc | med | `vto run affected` |
| W7 | Windows | analyzer build | MSVC Build Tools needed (F3) | doc | high (adoption) | prebuilt binaries |
| W8 | Windows | named pipe / kill / spawn | The random pipe name + token, `taskkill /T /F`, `windowsHide`, `.cmd` shims via cross-spawn, PATHEXT and `clip.exe` with a UTF-16LE BOM are all handled carefully and unit-tested with mocks. The fallback for `o` is `explorer.exe <file>`, which always exits 1, so the TUI may show an error toast although the file opened. | code | low | treat exit 1 from explorer as success |
| W9 | Windows | CRLF | `normText` strips BOM/CRLF for hashing (mcp). The analyzer uses `git diff`, and `.gitattributes` changes trigger run-all. The corpus has a CRLF case. I found no problem. `core.autocrlf=true` + a map recorded from the working tree (CRLF) vs `git cat-file blob` (LF) in `affected.rs` blob reads should be covered by a test. | code | low | add a CRLF/autocrlf contract test on the Windows CI leg |
| W10 | Windows | long paths | Paths are short (`.vto/map/t/<hash>.jsonl`, `node_modules/.vto/`). The only risk is deep user projects plus `.vto/blobs`. | code | low | – |
| W11 | Windows | Defender | The README mentions that the first run is slower. There is no advice to exclude `.vto/` and `node_modules/.vite`. | doc | low | add to the FAQ |
| A1 | macOS | NFD/NFC file names | No path in vto is Unicode-normalized (grep: none). Simulation: an edit to `src/utils/čeština.ts` reported with the NFD spelling (as `readdir` on APFS can return for files created by some tools / archives, while git with `core.precomposeUnicode` returns NFC) → `run all: src/utils/čeština.ts: not in the coverage map`, exit 3. With NFC: 164 tests selected. **Safe, but no speed-up for any file with diacritics**, which matters for a Czech team. The same mismatch in daemon `pathKey()` would mark files "new". | sim | med | `normalize('NFC')` in `slash()` / `paths::normalize` |
| A2 | macOS | case-insensitive APFS | `isCaseInsensitiveFs` is detected by probing, not assumed, and the projectKey is case-folded. `vitest-overlap`/analyzer path keys are **not** case-folded: a rename `Button.tsx` → `button.tsx` (a common mistake on macOS) could produce two entries. | code | low | case-fold keys when the probe says insensitive |
| A3 | macOS | socket path length | The 104-byte `sun_path` is handled (fallback to `mkdtemp` under `os.tmpdir()`). `~/Library/Caches/vto/run/<16 hex>/d.sock` is about 60 bytes. OK. | code | low | – |
| A4 | macOS | Terminal.app | no truecolor / no synchronized output → 256 colours + incremental redraw (documented, handled) | code | low | – |
| A5 | macOS | BSD `xargs` | `-r` is a no-op on BSD; `--print0` works; exit codes are lost the same way | doc | low | (W6) |
| L1 | Linux | no clipboard tool (server, container, WSL without interop) | The chain falls back to OSC 52, which "cannot be confirmed", so `c` may report success while copying nothing. | code | low | Toast "sent via OSC 52 (terminal must allow it)" plus write the prompt to `.vto/last-prompt.md` as a fallback the user can open. |
| L2 | Linux/CI | no TTY | TUI CI mode works (`--mock --ci` verified). Exit 0/1/2. `vto-daemon run …` output is plain. Good. `XDG_RUNTIME_DIR` is often missing in CI and Docker; the fallback `~/.cache/vto/run` works. | sim | low | – |
| L3 | Linux | shells | The docs use `(cd mcp && …)` subshells (bash/zsh ok). fish and nushell need different syntax. | doc | low | `npm --prefix mcp ci` |
| X1 | all | analyzer lookup | `vitest-overlap.mjs` looks up `$VTO_BIN` → repo build → **`vto` on PATH**. `mcp/` looks up `$VTO_ANALYZER` → npm package (sha256-checked) → repo build, and **never PATH** "for security". Two env var names, two policies. On npm, `vto` is someone else's package (F6), so a global `npm i -g vto` would put a foreign `vto` on PATH, and `vitest-overlap` would execute it. | code | med (security + confusion) | one resolver, one env var, no PATH |

### 2.2 What the platform code gets right

The IPC layer is careful. It uses a per-user `0700` dir, a token, and a random pipe name on Windows. Process trees
are killed with `taskkill /T`. Editor spawning uses argv only and goes through cross-spawn for `.cmd` shims. The
clipboard chain covers Windows, WSL, Wayland, X11 and OSC 52 with tmux passthrough. Colour and Unicode are
degraded per terminal. Case-insensitivity is detected by probing. The weak spots are all in the **collector**
(W1–W3), which is the part with the strongest recall impact, and the one with no platform unit tests
(`mcp/test/unit-platform.test.mjs` and `tui/test/platform.test.ts` exist; the collector has none).

### 2.3 GitHub Actions workflow (`.github/workflows/vto-ci.yml`)

What it does: `analyzer` builds and tests on 5 targets and packs `@jirikral/vto-analyzer-*` artifacts. Then `mcp` runs
`npm test` in `mcp/` on ubuntu, macOS arm64 and windows with the downloaded binary.

Correctness problems:

1. **`macos-13` is retired.** GitHub fully retired the macOS 13 image by 2025-12-04, with brownouts in November
   ([changelog](https://github.blog/changelog/2025-09-19-github-actions-macos-13-runner-image-is-closing-down/)).
   The `darwin-x64` leg will fail or queue. Use `macos-15-intel`. GitHub has also said x86_64 macOS support ends when
   the macOS 15 image retires (fall 2027).
2. `ubuntu-24.04-arm` is free only for public repos. In a private company repo it needs larger runners, or the job
   waits forever.
3. `fail-fast: false` plus `needs: analyzer` means one failing analyzer leg (e.g. #1) blocks **all** mcp legs.
   Use `needs` per platform (separate jobs, or a matrix `include` that downloads only its own artifact) and let the
   others run.
4. The `pack-analyzer` step runs `node` without `actions/setup-node`, so it uses whatever Node version the image has.
5. The integration and contract tests **skip themselves** when no fixture `node_modules` is found (`skip: 'no
   node_modules…'`), and a skipped test counts as passing. The CI does install it, but nothing asserts that the
   integration tests actually ran. Add `--test-reporter` with a check of the "skipped" count, or `VTO_REQUIRE_INTEGRATION=1`
   to turn the skip into a failure. Also remove the hard-coded `/home/claude/demo/node_modules` fallback.
6. On Windows, `export VTO_ANALYZER="$PWD/$BIN"` in Git Bash relies on MSYS path conversion of env vars to turn
   `/d/a/…` into `D:\a\…`. That usually works, but it is fragile. Resolve the path in Node, or use `cygpath -w`.
7. The README says "the CI matrix … has not run yet", so it has never been green. The workflow only triggers on
   `push: main` and `pull_request`.

Not covered at all (each would have caught a finding above):

| missing | would have caught |
|---|---|
| `node --check` on every `.mjs`, `vitest-overlap.mjs --help`, an end-to-end `vitest-overlap` run on a fixture | F1 (syntax error at HEAD) |
| `collector/selftest.mjs` + `collector/corpus` differential tests | instrumenter regressions on Windows (CRLF, paths) |
| collector on Windows with `new URL(…, import.meta.url)` fs reads and a lower-case drive letter | W1, W2 |
| `vitest-guard` `npm test` (unit + security) on 3 OS | vitest-guard regressions, `mkdtemp`/`O_NOFOLLOW` on Windows (Node has no `O_NOFOLLOW` there) |
| `tui` `npm test` (66 tests incl. pty e2e) on 3 OS | the TUI's real Windows/macOS paths (currently mocks only) |
| `verify/` | V1 (VALIDATION) |
| Node 20 (the declared minimum) and Node 24 | F8 |
| a path with spaces + diacritics (`D:\a\Můj projekt\`) | W4 |
| a Vitest `projects` fixture | D3 |
| macOS NFD fixture file | A1 |
| a lint for docs (dead links, `npx <name>` checks) | F6 |

---

## 3. Docs quality

### 3.1 Statements contradicted by measurements

| doc | statement | contradicted by | suggested wording |
|---|---|---|---|
| `mcp/README.md` §Full suite | "Instrumentation + collector cost no measurable CPU on the full suite (305 vs 308.5 s, within noise)" | VALIDATION C1: **+9.8 %** CPU full suite (n=4), +11.4 % dom, +11.7 % node | "+0–12 % CPU depending on how hot the code is (bench: within noise; the real-world suite: +10 %)" |
| `mcp/README.md` §Correctness | "**171 (recall 100 %)**" (10 mutants), "analyzer/faultinject … recall 100 %" | VALIDATION §4: 2 strict misses in 115 syntax-valid mutants (**99.92 %**), plus 2 confirmed misses through `fs` readers (CSS, source guard) | Report both numbers. Say the fs-reader fix exists but is not effective on Windows (W1). |
| `ARCHITECTURE.md` goals | "≥ 80 % less CPU in `vm` mode" marked "met" | the real-world suite: vm −40.8 % total, node project **+9 %** | "met on jsdom-heavy suites; −41 % on a half-node suite" |
| `ARCHITECTURE.md:499` | "vitest-guard: **refuses `test.projects`**" | supported since `2d7ddf9` (vitest-guard README, VALIDATION §3) | update |
| `ARCHITECTURE.md:39` | collection overhead "[GAP] no end-to-end suite overhead number" | VALIDATION now has one (+9.8 %) | fill in |
| `MCP.md` (design draft 1) | IPC "at `.vto/daemon.sock`", "~200 s for 3400 tests" | the socket lives in `$XDG_RUNTIME_DIR/vto/<key>/` / named pipe (PROTOCOL.md §4) | Mark MCP.md as historical, or merge it into PROTOCOL.md. `tui/README.md` still says "Schema per `MCP.md`". |
| `tui/README.md` (cs + en) | "the daemon has no task queue yet (`a` copies the task JSON)" | `enqueue_task` / `next_task` exist in `mcp/src/api.mjs` and `mcp-server.mjs` | update |
| `mcp/README.md` vs `vitest-guard/README.md` vs analyzer | the same suite is "3195 tests", "3193 tests", "3174 tests" | Vitest counts `it.each` rows separately; the map merges same name+line (documented limitation) | Explain once. Show "3195 tests (3174 distinct ids)". |
| `vitest-guard/README.md` table header | "**`vm`** … **66 (−86 %)**" as the headline | its own callout two paragraphs below: "only −40.8 % … pure-node +9 %" | Put the callout first, or give a range "−41 … −86 %". |
| `README.md` (root) | "`vto` (report.md … `vto affected`, `vto pack`)", and elsewhere "`vto ui`", "`vto verify`" | `vto ui` and `vto verify` are not commands of `vto` | §4.1 |
| `vitest-overlap.mjs` header | "`npx vitest-overlap`" | not published; with F1 it does not even parse | – |

### 3.2 Consistency between READMEs

- **Languages:** `mcp/README.md` and `vitest-guard/README.md` are English with a `README.cs.md`. `tui/README.md` is
  Czech-first with a shorter English part. The root README and `FORMAT.md` are English. Several reviews and
  validations use Czech verdict strings ("nelze ověřit", "potvrzeno redundantní") that are no longer the output
  (verify is English now). Pick English-first everywhere and move Czech to `*.cs.md`.
- **Install commands:** `npm ci --ignore-scripts` (mcp), `npm install` (tui), nothing (vitest-guard, root).
- **Analyzer env var:** `VTO_BIN` (`vitest-overlap.mjs`) vs `VTO_ANALYZER` (mcp, CI).
- **Language env var:** `VTO_LANG` / `--lang` is consistent across the analyzer, verify and the TUI. Good.
- **Exit codes:** analyzer `affected` 3 = run all, 2 = usage. vitest-guard 64 = usage, 2 = new quarantine, 3 = false
  green. vto-daemon 64 = usage (from `usage()`), 2 = error. TUI 2 = incomplete. The same number means different
  things (2 and 3), which hurts CI scripts. See §4.1.
- **Naming:** "vto" means the Rust binary, the npm workspace, the daemon prefix (`vto-daemon`), the UI (`vto ui`)
  and the project. "vitest-overlap" is the package name. "pyramids" is the repo. "vitest-guard" is a separate brand.

### 3.3 Missing docs

1. **"Which mode should I use?"** decision guide. There are three accelerators (selection, pool, warm daemon) and
   four pools (forks, vm, shared, auto). The facts exist, spread over 4 READMEs. A guide would be:

   | your situation | use |
   |---|---|
   | jsdom/happy-dom suite, CI is slow | vitest-guard `vm` in CI (`defineVitestGuardConfig`, `mode: 'vm'`) + nightly `VITEST_GUARD_MODE=isolated` + `verify` |
   | pure-node suite | keep `forks`, or `shared` after a clean `verify --mode shared --sample all` |
   | mixed (`projects` dom + node) | `mode: 'auto'` + `calibrate` |
   | local dev / AI agent loop | daemon + MCP (`run_affected`), pool `auto` |
   | PR pipeline | map from main (`vto map`), `vto run affected --base origin/main`, exit 3 → full |
   | "which tests are redundant?" | overlap report, then `verify` on the top candidates; never delete without reading |
   | security-critical tests | always `isolated` |
2. **Troubleshooting / FAQ:** "affected always says run all" (dirty tree, stale map, NFD, typo in the path), "tests
   pass in vto but fail in CI" (pool differs, D2), "`ERR_MODULE_NOT_FOUND vitest`" (F5), "analyzer binary not
   found", "Windows: no xargs", "MCP server doesn't start in Cursor", "how do I stop the daemon / where are its
   logs" (`%LOCALAPPDATA%\vto\run\<key>\`, `.vto/lane-*.log`), "Defender".
3. **Reference docs:** there is no single reference of CLI commands, env vars (≥ 15 across packages:
   `VTO_POOL`, `VTO_NO_DAEMON`, `VTO_HOOK`, `VTO_LANG`, `VTO_SIGNALS`, `VTO_ASYNC_TIMEOUT`, `VTO_SOURCEMAP`,
   `VTO_EDITOR`, `VTO_ASCII`, `VTO_UI_REDRAW`, `VTO_UI_NO_INK_PATCH`, `VTO_MCP_OUTPUT`, `VITEST_GUARD_MODE`,
   `VITEST_GUARD_OPTS`, `VITEST_GUARD_DIAG`, …), files written into the project (`.vto/`, `.vitest-guard/`,
   `overlap-report/`, `node_modules/.vto/`, `.vto-tmp/`) and which to commit.
4. **Uninstall / cleanup:** what to delete, how to stop daemons.
5. **Analyzer README:** `analyzer/` has none; its only doc is `--help` (R4).
6. **verify README:** none (V1).

### 3.4 English quality

The English is generally good: precise, technical, and honest about limits ("10 mutants is a small sample: it shows
no miss, it does not prove there is none"). Issues:

- Very dense. The main READMEs mix user docs, lab reports and design notes. `mcp/README.md` puts 160 lines of
  benchmark tables before "Setup", and `vitest-guard/README.md` puts 2 pages of mechanics before "CLI". Move the
  measurements into `docs/measurements.md` and lead with setup.
- Lab paths in user docs: `/home/claude/vmguard-lab`, `/tmp/vto-work/*.json`, `/path/to/real-work/…`.
- Czech leftovers: the `ARCHITECTURE.md` reference `vitest-guard/README.md "Měření"` / `"Celá heavy sada"` (anchors that
  now exist only in the Czech README), the TODO's "Zobrazit výstup", and the bilingual `--help` (U2).
- Jargon a new user cannot decode: "lane", "dirty", "shard", "fileload", "blocks", "realm", "tainted", "leaky",
  "items". Add a glossary.

---

## 4. Proposal

### 4.1 One CLI: `vto`

Today there are **7 entrypoints, 3 languages/runtimes and 5 install steps**: `vitest-overlap.mjs`, `vto` (Rust),
`collector/run-raw.mjs`, `verify/verify.mjs`, `vitest-guard`, `vto-daemon`, `vto-mcp`, `vto-ui`, plus the hook script.
Proposal: **one npm package** (scoped, e.g. `@<org>/vto`, see F6) with the bin `vto`. The Rust analyzer becomes an
internal `optionalDependencies` binary (`@<org>/vto-analyzer-<platform>-<arch>`, as esbuild does), never on PATH.
vitest-guard stays importable as a library (`@<org>/vto/guard` or its own scoped package) for `vitest.config.ts`.

```
vto init                       detect Vitest/projects/pools, write .vto/config.json, add .gitignore lines,
                               optionally wrap vitest.config with defineVitestGuardConfig, print/merge MCP + hook config
                               for Claude Code (.mcp.json, .claude/settings.json), Cursor (.cursor/mcp.json), VS Code (.vscode/mcp.json)
vto doctor                     Node/Vitest versions, analyzer binary + sha, git, config wrapped?, projects, daemon
                               endpoint, platform quirks (mintty, NFD, lower-case drive, subst), Defender hint
vto run [affected]             default: affected (daemon if running, else in-process)  [--base REF] [--clean] [--bail N]
vto run full | failed | <file[:line]>… [-t NAME]
vto affected [--base REF]      list only: --json | --files | --vitest [--print0]   (exit 3 = run all)
vto why <test-id|file:line>
vto ui [--mock|--file F|--latest|--wait]           (was tui/bin/vto-ui.mjs)
vto watch                                          (plain text stream; was vto-daemon watch)
vto daemon start|stop|status|logs
vto mcp                                            (stdio server; was mcp/bin/vto-mcp.mjs)
vto hook claude                                    (PreToolUse; was mcp/hooks/claude-pretooluse.mjs)
vto map record [-- vitest args] | status | pack --out F | import F | clear
vto report overlap [--threshold X] [--out DIR]     (was vitest-overlap.mjs + analyzer report)
vto report slow | imports | env | savings [--since 30d]
vto verify overlap [--top N] [--max-mutants N]      (was verify/verify.mjs)
vto guard check | verify | compare | calibrate | scan | plan | run | hunt <file> | report   (was vitest-guard)
vto ci github | azure [--out FILE]                 print a CI template (§4.3)
global: --root DIR  --json  --lang en|cs  --no-daemon  -q  -v  --version  --help
```

Rules:
- **One exit-code table** for all subcommands: `0` ok · `1` test failures · `2` usage/config error (also missing
  raw, unwrapped config, wrong Node) · `3` affected: run all · `4` guard: new quarantine/conflict (commit it) ·
  `5` guard verify: false green. (vitest-guard's `64` and its `2`/`3` move.)
- **One env namespace**: `VTO_*` (keep `VITEST_GUARD_MODE` as an alias). The analyzer is `VTO_ANALYZER` only.
- **One engine for "affected"**: the CLI, CI and MCP all use the daemon/core engine (blobs, dirty-tree aware). The
  Rust `affected` stays the selection kernel behind it. `vto map pack/import` is the only way a map travels to CI.
- **Safe defaults spelled out once**: `vto init` writes the pool choice into `.vto/config.json` and prints it.
  Every run's first line names the pool.
- English output. `--lang cs` everywhere. Help is generated per language, not bilingual.

### 4.2 10-minute quickstart (for the README)

Prerequisites: Node ≥ 22, git, a project with Vitest ≥ 5.1. Today a Rust toolchain is also needed. With prebuilt
binaries it is not.

**Windows (PowerShell, Windows Terminal recommended; Git Bash works for the CLI, use Windows Terminal for `vto ui`)**
```powershell
cd C:\src\my-app
npm i -D @org/vto                 # once published; today: see "from source" below
npx --no-install vto init         # writes .vto\config.json, .gitignore lines, .mcp.json, .claude\settings.json
npx --no-install vto doctor
npx --no-install vto run full     # 1st run records the map (≈ 1–7 min for 3,400 tests, depends on the pool)
# edit a component, then:
npx --no-install vto run          # only the affected tests, seconds
npx --no-install vto ui           # in a 2nd terminal: live failures, `o` opens VS Code at the line
```
From source today (Windows): install rustup + "Desktop development with C++" (MSVC), then
`git clone … C:\tools\vto; cd C:\tools\vto; npm ci --ignore-scripts; npm --prefix mcp ci --ignore-scripts;
npm --prefix tui ci; npm --prefix tui run build; cargo build --release --manifest-path analyzer\Cargo.toml`,
and use `node C:/tools/vto/mcp/bin/vto-daemon.mjs` in place of `vto` (forward slashes).

**macOS (zsh) / Linux (bash)**
```sh
cd ~/src/my-app
npm i -D @org/vto
npx --no-install vto init && npx --no-install vto doctor
npx --no-install vto run full
npx --no-install vto run
npx --no-install vto ui
```

**Then, for the agent (all OS):** restart Claude Code in the project. `vto init` already wrote `.mcp.json`
(`"command":"npx","args":["--no-install","vto","mcp"],"timeout":3600000`), and the optional hook steers `npx vitest run` to
`run_affected`. Cursor: `.cursor/mcp.json`, same server. VS Code: `.vscode/mcp.json` (`"servers"`).

**Then, for speed in CI (optional, 5 more minutes):** `npx vto guard compare --sample all`. Then wrap the config as
`vto init --guard` proposes, `npx vto guard check`, and commit `.vitest-guard/incompatible.json`.

### 4.3 CI templates

These are for the **user's** project. Principle: the map is recorded only on protected branches (trusted, FORMAT.md
"Map provenance"). PRs consume the map and fall back to a full run on exit 3. A nightly run uses `isolated` +
`guard verify`.

**GitHub Actions** (`.github/workflows/tests.yml`)
```yaml
name: tests
on:
  push: { branches: [main] }
  pull_request:
  schedule: [{ cron: '17 2 * * *' }]
permissions: { contents: read }
jobs:
  map:                                    # main only: full run, record + publish the map
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx --no-install vto run full --json > vto-run.json
      - run: npx --no-install vto map pack --out vto-map.jsonl
      - uses: actions/upload-artifact@v4
        with: { name: vto-map, path: vto-map.jsonl, retention-days: 30 }
  affected:                               # PRs: only the affected tests; exit 3 = run all
    if: github.event_name == 'pull_request'
    strategy: { fail-fast: false, matrix: { os: [ubuntu-latest, windows-latest, macos-latest] } }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }          # needs the merge base
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - uses: dawidd6/action-download-artifact@v6     # or actions/cache keyed by the main sha
        with: { workflow: tests.yml, branch: main, name: vto-map, if_no_artifact_found: warn }
      - name: affected tests
        shell: bash
        run: |
          if [ -f vto-map.jsonl ]; then npx --no-install vto map import vto-map.jsonl; fi
          npx --no-install vto run affected --base "origin/${{ github.base_ref }}" --no-daemon   # falls back to full when the map can't answer
  nightly:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx vitest run
        env: { VITEST_GUARD_MODE: isolated }
      - run: npx --no-install vto guard verify --sample 500    # exit 5 = false green
      - run: npx --no-install vto guard check --prune
```

**Azure Pipelines** (`azure-pipelines.yml`)
```yaml
trigger: { branches: { include: [main] } }
pr: { branches: { include: ['*'] } }
schedules:
  - cron: '17 2 * * *'
    displayName: nightly isolated
    branches: { include: [main] }
    always: true
variables: { npm_config_cache: $(Pipeline.Workspace)/.npm }
stages:
  - stage: test
    jobs:
      - job: map
        condition: and(eq(variables['Build.SourceBranch'], 'refs/heads/main'), ne(variables['Build.Reason'], 'Schedule'))
        pool: { vmImage: ubuntu-latest }
        steps:
          - task: UseNode@1
            inputs: { version: '22.x' }
          - task: Cache@2
            inputs: { key: 'npm | "$(Agent.OS)" | package-lock.json', path: $(npm_config_cache) }
          - script: npm ci
          - script: npx --no-install vto run full && npx --no-install vto map pack --out $(Build.ArtifactStagingDirectory)/vto-map.jsonl
          - publish: $(Build.ArtifactStagingDirectory)/vto-map.jsonl
            artifact: vto-map
      - job: affected
        condition: eq(variables['Build.Reason'], 'PullRequest')
        strategy:
          matrix:
            linux: { image: ubuntu-latest }
            windows: { image: windows-latest }
            mac: { image: macOS-latest }
        pool: { vmImage: $(image) }
        steps:
          - checkout: self
            fetchDepth: 0
          - task: UseNode@1
            inputs: { version: '22.x' }
          - script: npm ci
          - task: DownloadPipelineArtifact@2
            continueOnError: true                  # no map yet → full run below
            inputs:
              source: specific
              project: $(System.TeamProjectId)
              pipeline: $(System.DefinitionId)
              runVersion: latestFromBranch
              runBranch: refs/heads/main
              artifact: vto-map
              path: $(Pipeline.Workspace)/vto-map
          - pwsh: |
              if (Test-Path "$(Pipeline.Workspace)/vto-map/vto-map.jsonl") { npx --no-install vto map import "$(Pipeline.Workspace)/vto-map/vto-map.jsonl" }
              $base = "origin/$("$(System.PullRequest.TargetBranch)" -replace '^refs/heads/','')"
              npx --no-install vto run affected --base $base --no-daemon
              exit $LASTEXITCODE
            displayName: affected tests (pwsh on every OS – no xargs needed)
      - job: nightly
        condition: eq(variables['Build.Reason'], 'Schedule')
        pool: { vmImage: ubuntu-latest }
        steps:
          - task: UseNode@1
            inputs: { version: '22.x' }
          - script: npm ci
          - script: npx vitest run
            env: { VITEST_GUARD_MODE: isolated }
          - script: npx --no-install vto guard verify --sample 500 && npx --no-install vto guard check --prune
```

Azure notes: `System.PullRequest.TargetBranch` is `refs/heads/x` on Azure Repos and `x` on GitHub-hosted repos (hence
the `-replace`). Shallow fetch is the default on new pipelines, so `fetchDepth: 0` is needed for the merge base.
`pwsh` exists on all three hosted images.

**vto's own CI (`vto-ci.yml`) – minimum changes:** replace `macos-13` with `macos-15-intel`. Add a `lint` job
(`node --check` on every `.mjs`, `vitest-overlap.mjs --help`, `vto --help`, link check). Add jobs for `vitest-guard`,
`tui`, collector selftest + corpus, and an **end-to-end smoke** per OS: install as the README says, then
`vitest-overlap` on `mcp/test/fixture` → `vto affected` → `vto-daemon run-affected` → `vto-mcp` via the SDK client →
`vto-ui --file … --ci`. Run it from a checkout path with a space + diacritics. Add Node 22 + 24 (and 20 while it is
declared). Make each `mcp` leg depend only on its own analyzer leg. Fail when integration tests are skipped.

---

## 5. Summary: top findings

1. **S1** `vitest-overlap.mjs` (the main entrypoint) is a SyntaxError at HEAD `e6598d9` (`findBy*/waitFor` closes the
   JSDoc). CI never executes it. (F1)
2. **S1** The `vitest-guard check/compare` CLI on a config not wrapped with `defineVitestGuardConfig` reports "vm: 16 files,
   0 failing" and **recommends forks** (`vm +8 %`). Wrapped, the same suite gives vm −80 % / shared −88 %. It also
   writes that wrong result to `modes.json`. (G1)
3. **S1** vitest-guard cannot be installed the natural way (`npm i -D <path>` → `ERR_MODULE_NOT_FOUND vitest`), and
   **`vm-guard` on npm is an unrelated package**, so the documented `npx vm-guard …` can download and run foreign
   code. `vto` is also taken on npm. (F5, F6)
4. **S1** The Rust toolchain (edition 2024, ≥ 1.85; MSVC Build Tools on Windows) is required and not documented.
   No prebuilt binaries exist. The root README has no install/quickstart. (F2, F3)
5. **S1** The analyzer `vto affected` runs all for a map recorded on a dirty tree or at an older commit (the normal
   local case). It gives no warning at record time and no hint of the fix. The daemon engine does not have this
   problem, so two "affected" engines disagree. (R6)
6. **S1** The daemon's default `pool: auto` silently runs the user's jsdom tests in vitest-guard `vmThreads` (documented
   as "more tolerant than forks"), and the stateless and daemon modes pick different pools on the same project. This
   is the "passes in vto, fails in CI" trap. (D2, D3)
7. **S2/high-risk** Windows collector bugs by code review: `new URL().pathname` drops every URL-based fs read
   (`/C:/…`), so the A1 fs-reader fix is lost on Windows. The `fileload.modules` filter is case-sensitive (a lower-case
   drive letter gives silent recall loss). ROOT is not realpath'd (subst/junction/OneDrive). (W1–W3)
8. **S2** CLI fragmentation: 7 entrypoints, `VTO_BIN` vs `VTO_ANALYZER`, PATH lookup vs "never PATH", docs refer to
   `vto ui` / `vto verify` which do not exist, two different `watch`, conflicting exit codes (2/3/64), no `--version`.
   (§3.2, X1)
9. **S2** GitHub Actions: `macos-13` is retired (darwin-x64 leg fails). The workflow has never run. It tests only `mcp/`
   + analyzer. It does not run tui, vitest-guard, collector, verify or the `vitest-overlap` entrypoint. There is no Node 20
   leg, no path with spaces, and integration tests can skip silently. (§2.3)
10. **S2** Docs contradict the validation: "no measurable CPU" for instrumentation (+9.8 %), "recall 100 %" (99.92 % +
    fs misses), "vm −86 %" headline (−41 % on the real-world suite), "vitest-guard refuses projects", `.vto/daemon.sock`,
    "no task queue". Test counts 3195/3193/3174 for one suite. The TUI docs and help are Czech-first. (§3.1, U2)
11. **S2** Outputs that are hard to act on: `report.md` is 959 KB and flags 95 % of the suite (351 groups); "Group 1
    (4 items)" lists 15 tests; names are HTML-escaped. The analyzer usage is printed with literal `\u{a}`. A missing raw
    dir gives exit 3 = run all forever. A top-level `export` added to one file selects 71 % of the real-world suite (177 s in
    one blocking `run_affected`). (R3, R4, R5, D4)
12. **S3/med** macOS NFD names fall back to run all (simulated; safe but no speed-up for diacritic file names). Hook
    and MCP setup are documented for Claude Code only (no Cursor or VS Code). TUI advice `npx vto-daemon serve` points
    to a non-existent package. `.vitest-guard/run/*` shows up untracked when the daemon writes it. Under Git Bash/mintty the
    TUI degrades to CI mode. (A1, M2, U1, D5, W5)

What works well and should be kept: the error message for a wrong directory; the per-file reasons in `vto
affected`; the MCP server (22 tools, server instructions, compact grouped failures, lazy daemon); the daemon loop
(3195-test map in 64 s under vitest-guard, edits in 3 s); the TUI (live failures with code frames against the real
daemon); and the careful IPC, clipboard and editor platform layer. Paths with spaces and diacritics worked in every
entrypoint on Linux.
