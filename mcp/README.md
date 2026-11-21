# vto daemon + MCP server

Test feedback in seconds instead of a full `vitest run`, with answers small enough for AI agents.
vto keeps a per-test coverage map of your Vitest suite (collector v2, `../collector`), selects the tests
affected by a change (Rust analyzer, `../analyzer`), runs only those in a warm Vitest, streams
failures while the run continues, and patches the map after every run.

Czech version: [README.cs.md](README.cs.md). Protocol for clients (TUI, VS Code): [PROTOCOL.md](PROTOCOL.md).
Savings formulas: [SAVINGS.md](SAVINGS.md).

> **Running tests through vto executes your project's code**, exactly like `npx vitest`. Allow-listing
> the `run_*` / `start_run` / `rerun_failed` MCP tools equals allow-listing `npx vitest` in this repo.

## Layers

| layer | entry | what it adds |
|---|---|---|
| core library (stateless) | `src/engine.mjs` + `src/api.mjs` | map (`.vto/`), selection, runs in a Vitest child process ("lane"), compact output, redaction |
| CLI without daemon | `vto-daemon run-affected`, `ci-report`, any command with `--no-daemon` | same output rules, cold Vitest per call |
| MCP server | `bin/vto-mcp.mjs` | uses the daemon when available (lazily started), else the in-process core |
| daemon | `bin/vto-daemon.mjs serve` (auto-started) | warm lanes, event stream (failures as they happen), fix loop, live coverage, task queue, idle shutdown (30 min) |

Lanes are separate Node processes, each with one warm `createVitest` instance: `main` (affected/full/explicit
runs, instrumented), `fix` (re-runs of failed tests while the main run continues; 1 worker) and `clean`
(`instrumented: false`, e.g. the final check before a commit – the map is not touched).

## Measured on bench-project (312 files / 3195 tests, React 19 + RTL + jsdom)

2 shared cores, other agents running (load 4–10): **CPU** is the reliable metric, wall is indicative.
Raw data: `/tmp/vto-work/*.json` (not in the repo); scripts `dev/bench.mjs`, `dev/recall.mjs`, `dev/proc-cpu.mjs`.

### Full suite

| run | pool | wall | CPU |
|---|---|---|---|
| `npx vitest run` (plain, default reporter) | forks (Vitest default) | 698 s | 308.5 s |
| vto cold first run = full collection (instrumented, map recorded) | forks | 455 s | 305 s |
| vto cold first run = full collection | vm-guard `vm` (vmThreads) | 71 s | 47 s |
| `npx vitest run` with the vm-guard config (reference runs of the recall check) | vm-guard `vm` | 49–58 s | – |

Instrumentation + collector cost no measurable CPU on the full suite (305 vs 308.5 s, within noise).

### One edit → affected tests (forks pool, bench copy)

| scenario | selected | plain `vitest run <files>` cold | vto stateless (cold) | vto warm daemon |
|---|---|---|---|---|
| CartBadge, behaviour-preserving edit | 80 / 3174 tests, 8 files | 7.3 s / 7.1 s CPU | 11.2 s / 7.3 s CPU | 10.8 s / 7.6 s CPU |
| CartBadge, breaking edit (19 failures) | 80, 8 files | 9.9 s / 7.4 s CPU | 9.6 s / 7.6 s CPU | 9.2 s / 7.1 s CPU, first failure after 1.3 s |
| useQuantity hook, boundary edit | 61 (67 run), 8 files | 8.8 s / 8.2 s CPU | 8.9 s / 8.3 s CPU | 7.2 s / 8.1 s CPU |
| api/client.ts top-level constant (module mocked) | 400, 40 files | 44.9 s / 37.6 s CPU | 46.0 s / 39.7 s CPU | 46.4 s / 40.0 s CPU |

vs. the full run: **98 % less CPU** for a component edit (7 s vs 305–308 s), 87 % for a widely imported module.

**Warm daemon vs stateless: no CPU saving with the forks pool** (±5 %, noise). As predicted in
ARCHITECTURE.md ADR-7, ≈80 % of the cost is the per-file jsdom environment + module evaluation, which a warm
main process cannot keep under `isolate: true`. What the daemon does buy: no Vitest/Vite startup per call
(~1–2 s wall), failures *during* the run (time to first failure 1.3 s vs 9.2 s for the whole run), the
fix loop, live coverage and the map in memory. The big levers are selection and the pool (vm-guard `vm`).

### Same edits with the vm-guard `vm` pool (bench copy with `"pool":"vm"`)

| scenario | selected | plain `vitest run <files>` (vm-guard config) | vto stateless | vto warm daemon |
|---|---|---|---|---|
| CartBadge, behaviour-preserving | 80 | 2.2 s / 2.2 s CPU | 2.0 s / 2.2 s CPU | 1.9 s / 2.2 s CPU (1.6 s after revert) |
| CartBadge, breaking (19 failures) | 80 | 2.4 s / 2.3 s CPU | 2.4 s / 2.4 s CPU | 1.9 s / 1.8 s CPU, first failure after 0.8 s |
| useQuantity hook | 61 (67 run) | 2.7 s / 2.5 s CPU | 3.0 s / 2.8 s CPU | 2.2 s / 2.1 s CPU |
| api/client.ts top-level | 400 | 13.1 s / 6.9 s CPU | 13.9 s / 7.6 s CPU | 13.3 s / 7.8 s CPU |

With vm-guard the whole agent iteration (select + run + map patch) is ~2 s for a component edit vs 56–71 s
for the full suite (−97 %), and vs 698 s / 308 s CPU for the plain Vitest default (forks). Warm vs cold again
differs by only 0.1–0.8 s wall: Vitest + Vite start is cheap here (~0.5 s), the cost is per test file.

### Time to first failure (full run, vm-guard, failing tests injected into two files)

| | first failure | whole run (when the classic workflow shows it) |
|---|---|---|
| failure in a file that ran at position 174/312 | 40.8 s | 56.7 s |
| failure in a file that ran at position 306/312 | 56.2 s | 56.7 s |
| affected run, CartBadge breaking edit (forks / vm) | 1.3 s / 0.8 s | 9.2 s / 1.8 s |

Vitest's own sequencer orders the files (cached duration, failed files first), so a failure is streamed when its
file runs; the gain is (run end − that moment), on average about half a run for uniformly placed failures.

### One lane vs two lanes (dom / node groups, `pool: "auto"`)

Two warm main lanes run in parallel inside one run: `dom` (vm-guard `vm`) and `node` (`forks`); see PROTOCOL.md §9.
CPU budget on this box = 1 worker (cores − 1) per single lane; the two lanes get 1 worker each.

| project / run | one lane | two lanes | Δ wall | Δ CPU |
|---|---|---|---|---|
| the real-world suite (1992 tests: 113 jsdom + 136 node-env files), full | 408 s / 195 s CPU (their config: vmThreads both projects) | 227 s / 188 s CPU | **−44 %** | −4 % |
| the real-world suite, edit `src/game/hash.ts` (180 tests) | 61–68 s / 31.5–32.7 s CPU | 39–44 s / 33.7–37.1 s CPU | **−35 %** | +3 … +14 % |
| the real-world suite, one lane with `maxWorkers: 2` (same worker count as two lanes), full | 264 s / 197 s CPU, 11 timeouts under load | 227 s / 188 s CPU, 0 failures | −14 % | −5 % |
| the real-world suite, one lane `maxWorkers: 2`, edit (180 tests) | 35–69 s / 35–52 s CPU (noisy, timeouts) | 39–44 s / 34–37 s CPU | ≈ | ≈ |
| bench-project (all jsdom), full | 94 s / 44.8 s CPU (vm) | 98 s / 51.9 s CPU with 8 DOM-free jsdom files in forks | +4 % | **+16 %** |
| bench-project, edit `src/utils/čeština.ts` (153 tests) | 5.3 s / 2.6 s CPU | 11.6 s / 7.5 s CPU (same routing) | +119 % | +188 % |
| bench-project, same with `nodeEnvironment: "node"` | | full 73 s / 46.4 s CPU, edit 4.6 s / 3.8 s CPU | −22 % / −13 % | +3 % / +46 % |

Lessons, now the routing default: a file goes to the `node` lane only when its **configured** environment is
node (the real-world suite's `node` project). Files that merely never touched the DOM stay in the `dom` lane unless
`nodeEnvironment: "node"` – a jsdom file in `forks` re-creates jsdom per file and costs 2–3× more CPU. On a
suite with no node-environment files (bench-project) the node lane stays empty and nothing changes. The wall gain
of two lanes is mostly parallelism (two workers instead of one): against one lane with the same 2 workers the
full run is −14 % wall / −5 % CPU (node-environment files are cheaper in forks than in vmThreads, as the
the real-world suite validation measured), the edit run is within noise. Load average was 5–7 during these runs.
The classification is also written to
`.vm-guard/run/env.json` for vm-guard `mode: 'auto'`.

### Event stream volume (daemon → subscriber, bench-project, vm-guard)

| run | events | bytes | largest event |
|---|---|---|---|
| full run (3195 tests, 56 s): `test` | 3195 | 494 KB | 224 B |
| full run: `file-start` / `progress` | 312 / 369 | 28 KB / 41 KB | 111 B |
| full run: `coverage` partial / final (39 source files) | 310 / 39 | 2.40 MB / 0.31 MB | 14.2 KB |
| affected run (80 tests, 1.6 s): all events incl. 4 `coverage` | 103 | 31 KB | 4.6 KB |

Coverage events are only computed while a client subscribes to `coverage`; the full run took 56.4 s with a
coverage subscriber vs 56.5 s without.

### Tokens (approx. chars/4) for the same run

| run | vto MCP | Vitest agent default (`minimal`, chosen by Vitest 5 under Claude Code) | default reporter | verbose |
|---|---|---|---|---|
| 80 tests pass | **88** | 126 | 224 | 1 990 |
| 80 tests, 19 failures | **789** (5 grouped failures) + 222 per `why_failed` | 2 721 | 3 285 | 4 439 |
| 400 tests pass | **90** | 122 | 656 | 11 578 |
| full suite, 3195 pass | **~90** | – | 4 937 (19.7 KB) | – |

Honest note: for passing runs Vitest 5's own agent reporter is already small (≈120 tokens); vto's gain there is
the 98 % CPU/time, not tokens. For failing runs vto is 3.4× smaller than the agent reporter (grouping, ≤3
frames, short diffs) and the details are fetched only for the test the agent works on.

Typical response sizes (warm daemon, bench-project):

| tool | tokens | | tool | tokens |
|---|---|---|---|---|
| `affected_tests` (8 files) | 131 | | `daemon_status` | 155 |
| `run_affected` (pass) | 88–90 | | `run_affected` (19 failures) | 789 |
| `why_failed` | 222 | | `start_run` | 54 |
| `next_failures` (first batch) | 156 | | `run_status` | 65 |
| `rerun_failed` | 53 | | `coverage_of {file}` | 97 |
| `coverage_of {file, detail:"full"}` (10 lines/page) | 649 | | `tests_for_line` (10/page) | 305 |
| `test_overlap {file}` (5/page) | 446 | | `slow_tests` | 430 |
| `suggest_env` (10/page) | 251 | | `vm_guard_status` | 78 |
| `savings_report` | 197 | | `slow_imports` | 284 |
| `list_tasks` | 35 | | `coverage_of {test}` | 44 |

Budgets are enforced per tool by `test/integration.test.mjs` (CI); every response is hard-capped at 8000 chars.

### Correctness (recall check)

`node dev/recall.mjs` – random single-line mutations (faultinject operators) of `src/`, each followed by a warm
`run_affected` and a full reference run without vto (same vm-guard config, no instrumentation):

| mutants | killed | tests failing in the full runs | of them selected by vto | state mismatches (vto vs full, selected tests) | run-all answers | mean selected | mean time vto / full |
|---|---|---|---|---|---|---|---|
| 10 | 6 | 171 | **171 (recall 100 %)** | **0** | 0 | 74 of 3174 tests (2.3 %) | 8.6 s / 58 s (one mutant made tests hit their timeouts: 61 s / 109 s) |

Plus `analyzer/faultinject` (60 mutants on the analyzer fixture, recall 100 %) for the selection logic alone.
10 mutants is a small sample: it shows no miss, it does not prove there is none.

## Setup for Claude Code

Requirements: Node ≥ 20 (22 recommended), the project's own `vitest` (5.1.x tested), git optional
(only for `base`), the analyzer binary (`cargo build --release` in `analyzer/`, or the npm package
`@vto/analyzer-<platform>-<arch>`, or `VTO_ANALYZER=<path>`).

```sh
git clone <repo> vto && cd vto
npm ci --ignore-scripts && (cd mcp && npm ci --ignore-scripts)
(cd analyzer && cargo build --release)
```

### Windows (PowerShell)

```powershell
# 1. MCP server for the project (run in the project root; one line):
claude mcp add --scope project --transport stdio vto -- node C:\tools\vto\mcp\bin\vto-mcp.mjs
# or commit this .mcp.json in the project root (forward slashes work):
#   {"mcpServers":{"vto":{"command":"node","args":["C:/tools/vto/mcp/bin/vto-mcp.mjs"],"timeout":3600000}}}
# 2. optional hook: .claude/settings.json in the project (matcher covers the PowerShell tool too)
#   {"hooks":{"PreToolUse":[{"matcher":"Bash|PowerShell","hooks":[{"type":"command","command":"node","args":["C:/tools/vto/mcp/hooks/claude-pretooluse.mjs"]}]}]}}
# 3. first run (records the map; or let the agent call run_affected):
node C:\tools\vto\mcp\bin\vto-daemon.mjs run-affected
```

Notes: use `node <script>` (not the npm `.cmd` shims) in `command`/`args`; the daemon IPC is a named pipe
`\\.\pipe\vto-<random>` published in `%LOCALAPPDATA%\vto\run\<key>\endpoint.json`; process trees are
stopped with `taskkill /T /F`. On Windows Defender-heavy machines the first run is slower (many small files).

### macOS / Linux

```sh
claude mcp add --scope project --transport stdio vto -- node /opt/vto/mcp/bin/vto-mcp.mjs
# hook (optional), .claude/settings.json:
#   {"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"node","args":["/opt/vto/mcp/hooks/claude-pretooluse.mjs"]}]}]}}
node /opt/vto/mcp/bin/vto-daemon.mjs run-affected
```

The socket lives in `$XDG_RUNTIME_DIR/vto/<key>/` (Linux) or `~/Library/Caches/vto/run/<key>/` (macOS), both `0700`.

`examples/mcp.json` and `examples/claude-settings.json` contain the same snippets. `.mcp.json` supports
`${VAR}` / `${VAR:-default}` expansion, so a team can use `"args": ["${VTO_HOME}/mcp/bin/vto-mcp.mjs"]`.
Long runs: the per-server `"timeout"` (ms) overrides `MCP_TOOL_TIMEOUT`; prefer `start_run` + `next_failures` anyway.

### The hook

`hooks/claude-pretooluse.mjs` **only denies** the exact commands `npx vitest [run]`, `npm [run] test`,
`pnpm [run] test`, `pnpm vitest [run]`, `yarn [run] test`, `yarn vitest [run]` (optionally followed by plain
test paths) with a one-line hint to use `run_affected` / `run_tests`. It never returns `allow`, never rewrites
the command, and stays silent for everything else (options, quotes, `;`, `|`, `$()`, env assignments…), so
the normal permission flow applies. The agent can still run Vitest directly with any option. `VTO_HOOK=off` disables it.

### Typical agent loop

1. edit → `run_affected` (≤ ~100 tokens when green)
2. failure → `why_failed {test}` → fix → `run_affected`
3. long runs: `start_run` → `next_failures` (long-poll, grouped) → fix while it runs; the daemon re-runs the
   fixed tests in the fix lane (`fixedDuringRun`)
4. before finishing: `run_affected {base: "origin/main"}`; with `instrumented: false` for a run without the collector.

## Tool reference (MCP, schema `vto/1`)

Every result: `v`, `stale` (+`staleReasons`), `mapAgeS`; run results also `runAll`, `instrumented`, `pool`.
Inputs are strict (unknown fields rejected); filters are typed `{file, line?, name?}` (`name` = literal
substring); paths are relative and must stay inside the project; `base` must be a plain git ref
(`^[A-Za-z0-9._/~^@{}-]+$`, not starting with `-`), resolved to a commit sha before use.

| tool | input | output (default) |
|---|---|---|
| `affected_tests` | `base?`, `limit?`, `cursor?` | `{count, total, runAll, reasons, changed, files (page), filesTotal}` – runs nothing |
| `run_affected` | `base?`, `bail?`, `timeoutS?`, `instrumented?` | `{ran, passed, failed, skipped, total, ms, cpuMs, firstFailureMs, failures[≤5 groups], failureGroups, mapUpdated}` |
| `run_tests` | `filters[]`, `bail?`, `timeoutS?` | same as `run_affected` |
| `why_failed` | `test` (id or `file:line`) | message, diff (≤80 lines), ≤10 project frames with source, ±2 lines of source, console (redacted, ≤2 KB), `coveredChanged` |
| `daemon_status` | – | lanes (warm?), pool, map (tests, files, gitHead, dirty, failing), memory, active run, backend |
| `start_run` | `kind` (affected/full/tests/failed), `filters?`, `base?`, `bail?`, `timeoutS?`, `instrumented?` | `{runId, total, files, lane}` immediately |
| `next_failures` | `runId`, `cursor?`, `waitS?` ≤30, `limit?` ≤20 | new failures since cursor (grouped), `cursor`, `done`, `progress` |
| `run_status` | `runId?` | progress or the final summary |
| `cancel_run` | `runId` | `{status}` |
| `rerun_failed` | `runId?`, `ids?`, `lane?` | `{runId}`; runs in the fix lane while a main run is active |
| `next_task` / `list_tasks` / `complete_task` / `enqueue_task` | see PROTOCOL.md | task queue (failure groups handed over from the TUI key `a` or another agent) |
| `test_overlap` | `file?` / `test?` scope, page | identical / subset / near-duplicate candidates (never the whole report) |
| `slow_tests` | `file?`, page | slowest tests without unique coverage + their total |
| `slow_imports` | `file?`, page | heaviest modules (Σ own load time × loading files); with `file`: unused imports of that test file |
| `suggest_env` | `file?`, page | test files that never touched DOM globals → candidates for `node` environment |
| `coverage_of` | `{test}` / `{file, line}` / `{file, live?, detail?}` | lines a test covers / tests covering a line / covered-partial-uncovered ranges (live during a run) |
| `tests_for_line` | `file`, `line`, page | tests covering the line |
| `vm_guard_status` | – | mode, quarantined files, dirty-start warnings |
| `savings_report` | `since?` (`30d`) | runs, full runs avoided, CPU/wall saved, tokens vs classic, time to first failure (SAVINGS.md) |

Resources: `vto://runs/{runId}/failures` (subscribable: `notifications/resources/updated` on new failures),
`vto://map/meta`, `vto://report/summary` (savings summary – never the full report). Long tool calls send
`notifications/progress` when the client passes a progress token. No `verify` tool (mutation runs execute
mutated code – CLI only, SECURITY-REVIEW F13). `VTO_MCP_OUTPUT=text|structured|both` (default `text`: JSON in
the text content, prefixed with an "untrusted test data" marker).

## CLI (`vto-daemon`)

```
vto-daemon status | affected [--base REF] | run [--full|--failed] [--file F[:LINE]]… [--name TEXT] [--base REF] [--clean]
           run-affected [--base REF]          # stateless, no daemon
           watch | why <test-id> | savings [--since 30d] [--json] | ci-report [--base REF] [--full] [--out FILE] | stop
common: --root DIR, --json, --no-daemon, --bail N, --timeout S
```

Exit codes of `run*`: 0 green, 1 failures, 2 error.

## Configuration (`.vto/config.json`, env)

| key / env | default | meaning |
|---|---|---|
| `pool` / `VTO_POOL` | `auto` | `auto`: two warm main lanes, `dom` + `node` (below); `vm` / `shared`: one lane, config wrapped with vm-guard; `forks` / `threads` / `vmThreads` / `vmForks`: one lane with that pool; `config`: one lane as configured |
| `groups` | on with `pool: auto` | `false` = one main lane |
| `groupPools` | `{"dom":"vm","node":"forks"}` | pools of the two lanes |
| `nodeEnvironment` | – | `"node"`: also route jsdom files that never touched the DOM to the node lane and run them in `node` |
| `maxWorkers` | cores − 1 | worker budget (split between the lanes by measured test time) |
| `fixLoop` | `true` | daemon: re-run failed tests of the active run when files they cover change |
| `idleMinutes` | 30 | daemon idle shutdown |
| `coverageCap` | 3 | test ids per line in `coverage` events |
| `mcpAllowRuns` | all kinds | e.g. `["affected","tests","failed"]` to forbid full runs via MCP |
| `VTO_ANALYZER` | – | path of the analyzer binary (trusted) |
| `VTO_NO_DAEMON=1` | – | MCP/CLI never start a daemon |
| `VTO_HOOK=off` | – | disable the hook |

## Map maintenance (how `.vto/` stays correct)

- Every file the map depends on (instrumented sources, modules loaded by test files, test files) is
  tracked with the sha1 of the version that was recorded; a copy of that version is kept in `.vto/blobs/`.
  Selection diffs the recorded version against the working tree (no git needed; uncommitted edits work).
- After each run the records of the tests that ran replace their rows; a fully run test file replaces its
  whole shard (deleted tests disappear). When a source file's version advances, records of tests that did
  not run are remapped block-by-block through the line diff; anything that cannot be mapped, and any change
  outside blocks or in import-time code, marks the affected tests/files **dirty** (always selected until re-run).
- Always selected: dirty tests, previously failing tests, new test files, changed test files (whole file).
- Run-all triggers (map stale, lanes restarted): package.json, lockfiles, vite/vitest config, tsconfig*,
  setup files, `.env*`, `.gitattributes`, `.vm-guard/incompatible.json` / `conflicts.json`.
- Files edited *during* a run do not advance; the tests of that run that touched them are marked dirty.
- Change detection is stat (mtime+size) → hash, no file watchers (same behaviour on all OSes).

## Security

- IPC: per-user `0700` directory, `0600` socket, 256-bit token in `endpoint.json` (`0600`), constant-time
  check, 1 MiB message limit, never TCP. Windows: random pipe name per start + token (Node cannot set a pipe
  DACL; documented in PROTOCOL.md §4). No peer-UID check (needs a native addon).
- Output: all strings are stripped of ANSI/OSC/C0/C1/bidi/zero-width characters and redacted (tokens,
  JWT, AWS/GitHub/Slack/OpenAI-style keys, `user:pass@` URLs, `KEY=value` for secret-looking keys, verbatim
  values of secret-looking env vars) before they leave the engine – also in `state.json`.
- Inputs: strict schemas, typed filters, root-confined paths, validated git refs resolved with
  `--end-of-options`; any git failure ⇒ `runAll`, never "0 tests".
- Analyzer binary: never from PATH/cwd; npm package binaries are verified against the sha256 in their package.json.
- Lockfiles for `mcp/` and the test fixture; CI installs with `npm ci --ignore-scripts`.

## Known limitations

- Measured on Linux only. Windows/macOS code paths (named pipe, `taskkill`, LOCALAPPDATA, macOS socket
  length, case-insensitive FS detection) are unit-tested with mocks; the CI matrix
  (`.github/workflows/vto-ci.yml`) runs the real tests on all three but has not run yet.
- `cpuMs` in run results excludes forked worker processes (forks pool); the bench numbers use `/proc` tree CPU.
- Tests with identical names on the same line (`test.each` rows with equal titles) share one map entry (hits unioned).
- Change detection relies on mtime+size; an edit within the same mtime tick that keeps the size is missed until the next stat change.
- Workers reused across runs (`isolate: false`, shared mode) may skip re-emitting unchanged block tables; the
  map keeps the previous table (identical by construction).
- `suggest_env` only sees DOM access after the user's setup files; a DOM-touching setup file makes every file look DOM-dependent.
- The vm-guard wrapper for non-vm-guard configs is generated in `.vto/setup/`; vm-guard's sequencer prints a
  harmless "vitest/node treated as external" warning into `.vto/lane-main.log`.
- New source files that no test imports yet are ignored until an importer changes (reported in `notes`).
- The fix lane is a second warm Vitest (memory); it is closed after 5 idle minutes.
- The vm-guard `vm` gain depends on the per-file environment cost: large for jsdom suites (here −85 %), small or
  negative for pure-node projects (a private real-world repository validation: node project +9 % CPU vs forks) – use `forks`
  or vm-guard `shared` there (`"pool"` in `.vto/config.json`).
- Any analyzer failure (crash, rejected map, unreadable output) makes `affected` answer `runAll` with the
  analyzer's message as the reason; the map files are named `s-*.jsonl` because the analyzer reads only `w-*`/`s-*`.
- Engines refuse to start outside a Vitest project (no `.vto/` is created there) and only one engine (daemon or
  stateless CLI) may own a project's `.vto/` at a time.

## Tests

`npm test` (node:test): unit tests (diff, store patching/remap, coverage, IPC auth/limits, platform mocks,
redaction, hook grammar, ref validation, response caps) and integration tests on `test/fixture` (real Vitest:
stateless loop, daemon streaming + fix loop + fix lane + console redaction, MCP over stdio with token budgets).
`dev/mock-events.mjs` replays a realistic run over the real protocol for TUI/VS Code development.

## Analyzer distribution plan

Prebuilt binaries per platform as npm packages `@vto/analyzer-<platform>-<arch>` (`linux-x64`, `linux-arm64`,
`darwin-arm64`, `darwin-x64`, `win32-x64`) with `os`/`cpu` fields, listed as `optionalDependencies` of the JS
package (esbuild/oxc scheme); built and packed in the CI matrix (`scripts/pack-analyzer.mjs`, sha256 recorded
in the package). Publishing (npm trusted publishing with provenance, signed binaries) is not set up yet.
