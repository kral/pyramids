# vto daemon + MCP – design (draft 1)

Goal: AI agents (Claude Code, Cursor, …) and humans get test feedback for a change in seconds
instead of a full `vitest run` (~200 s for 3400 tests), with answers small enough to save tokens.

## Architecture

```
            MCP (stdio)          CLI / git hooks / CI           (IDE extension later)
                 \                      |                         /
                  +------------  vto daemon (Node)  -------------+
                  |  warm Vitest (Node API createVitest, Vite server, transform cache)
                  |  collector plugin v2 always on (per-test hits, fileload, durations)
                  |  vto core (Rust, napi or child process) – map in memory, incremental
                  +-- state: .vto/ (map snapshot, gitHead, file hashes, vm-guard quarantine)
```

- One daemon per project root; started lazily by the first MCP/CLI call; IPC over a local
  socket / named pipe (Windows) at `.vto/daemon.sock`; idle shutdown after N minutes.
- Every run (affected or explicit) re-records coverage for the tests it ran and patches the map
  (replace those tests' rows). Full collection = nightly / on demand.
- Invalidation: change in package.json, lockfile, vitest/vite config, tsconfig, setupFiles,
  .env* → map marked stale, `affected` answers `runAll: true` with the reason, daemon restarts Vitest.
- Map validity per file: content hash at record time; file edited since → old-side diff mapping
  against the recorded version (git blob or cached copy in .vto/).

## Token budget rules (all tools)

1. Default output is a **summary object** ≤ ~300 tokens; details only on request (`detail:"full"`),
   always paginated (`limit`, `cursor`).
2. Passing tests are never listed, only counted.
3. Failures: test id, assertion message, compact expected/received diff (truncated to N lines),
   top 3 project stack frames (no node_modules frames), the source line. Console output only for
   failing tests, deduped and truncated.
4. Identifiers are short and stable: `src/Button.test.tsx:42` (file:line), paths relative.
5. Repeated identical failures are grouped ("same error in 12 tests").
6. Every response carries `stale`/`runAll` flags so the agent never has to guess.

## MCP tools

| tool | input | output (default) |
|---|---|---|
| `affected_tests` | `{ base?: "HEAD"\|sha, diff?: string }` | `{ count, total, runAll, reasons[], files[] (≤20) }` |
| `run_affected` | `{ base?, bail?, timeoutS? }` | `{ ran, passed, failed, skipped, ms, failures[] (≤5, compact) , mapUpdated }` |
| `run_tests` | `{ filters: ["file", "file:line", "name regex"] }` | same as run_affected |
| `why_failed` | `{ test }` | full failure for one test: diff, frames, covered lines changed in the diff |
| `test_overlap` | `{ file? , test? }` | candidates for review in that scope (tiers, reasons), ≤10 |
| `slow_tests` | `{ limit? }` | slowest tests without unique coverage + total time |
| `slow_imports` | `{ file? }` | heaviest modules loaded (loadMs × files), unused imports for that file |
| `suggest_env` | `{ file? }` | test files that never touched DOM → can run in `node` env |
| `coverage_of` | `{ test }` or `{ file, line }` | which tests cover a line / which lines a test covers (paginated) |
| `vm_guard_status` | `{}` | quarantined files, last check, leak warnings |
| `daemon_status` | `{}` | map age, gitHead, stale reasons, warm/cold, memory |

Resources (read-only, cacheable by clients): `vto://report/summary`, `vto://report/overlap`,
`vto://map/meta`.

## Typical agent loop (what we want Claude Code to do)

1. Edit code → `run_affected` → ~2–15 s, ≤ 400 tokens back.
2. On failure → `why_failed` for one test → fix → `run_affected` again.
3. Before finishing → `run_affected { base: "origin/main" }`; full suite only if `runAll`.

A Claude Code hook (PreToolUse on Bash) can redirect `npx vitest run` / `npm test` to
`run_affected` and print a one-line hint, so agents use it without prompting.

## Expected savings (to be measured, not promised)

- Time per iteration: full run ~200 s → affected run seconds (fault injection: avg ~12 % of tests
  selected for logic changes) + no cold start (daemon warm).
- Tokens per iteration: full Vitest log of thousands of lines → summary of a few hundred tokens.

## Build order

1. Daemon core: warm Vitest via Node API, rerun by file:line filters, incremental map patch.
2. MCP server (stdio, official TS SDK) with `affected_tests`, `run_affected`, `why_failed`,
   `daemon_status`; measure tokens per response on the bench project.
3. Remaining analysis tools (overlap, slow, imports, env, coverage_of, vm-guard).
4. Claude Code hook + `.mcp.json` snippet, Windows named pipe, idle shutdown.

## Open questions

- Rust core as napi addon (in-process, fastest) vs child process (simpler distribution).
- Run in the daemon with the user's pool (vmThreads + vm-guard) or forks for safety?
- Concurrency: two agents/editors calling `run_*` at once → queue, coalesce identical requests.

---

## Live streaming of failures (added: user requirement)

Goal: start fixing failed tests **while the run continues**, both for humans (TUI) and AI agents (MCP).

### Daemon event stream (single source for TUI, CLI and MCP)
The daemon uses a custom Vitest reporter (`onTestCaseResult`, `onTestModuleEnd`, …) and publishes
newline-delimited JSON events over the same IPC socket/pipe (`subscribe` request; many subscribers):

```jsonc
{"ev":"run-start","runId":"r12","kind":"affected|full|tests","total":412,"files":38,"pool":"vm"}
{"ev":"file-start","runId":"r12","file":"src/Button.test.tsx","project":"dom"}
{"ev":"test","runId":"r12","id":"src/Button.test.tsx:42 > Button > disabled","state":"pass|fail|skip","ms":12}
{"ev":"failure","runId":"r12","seq":3,"id":"…","file":"…","line":42,"message":"…","diff":"…(≤40 lines)",
 "frames":[{"file":"src/Button.tsx","line":17,"col":5,"code":"…"}],"group":"g-7a1c","coveredChanged":["src/Button.tsx:17"]}
{"ev":"progress","runId":"r12","done":120,"failed":3,"etaMs":8400}
{"ev":"fix-rerun","runId":"r12","id":"…","state":"pass|fail"}          // see fix loop
{"ev":"run-end","runId":"r12","passed":405,"failed":7,"skipped":0,"ms":21400}
```
Failures are emitted the moment a test fails (not at file end). `group` = hash of normalized error
(same error in many tests → one group). Events are also appended to `.vto/runs/<runId>.jsonl`.

### Fix loop
While a run is in progress, a saved file that is covered by an already-failed test triggers an
immediate targeted re-run of just those failed tests in a separate lane (does not restart the main
run). Result arrives as `fix-rerun`. The main run's final summary marks failures "fixed during run".

### MCP (portable: works in clients without streaming support)
- `start_run { kind: "affected"|"full"|"tests", filters?, base? }` → returns immediately `{ runId, total }`.
- `next_failures { runId, cursor?, waitS?: ≤30, limit?: 5 }` → long-poll: returns new failures since
  cursor as soon as ≥1 is available (or on timeout/run end) `{ failures[], cursor, done, progress }`.
  Agents loop: next_failures → fix → next_failures … Each failure is compact (token rules apply);
  identical groups are returned once with a count.
- `run_status { runId }`, `cancel_run { runId }`, `rerun_failed { runId, ids? }`.
- Additionally (best effort, clients that support it): MCP progress notifications on long tool
  calls and `notifications/resources/updated` for `vto://runs/<runId>/failures`.
- Parallel fixing: each failure group is a self-contained task (id, file:line, message, diff, the
  covering source lines) so an orchestrating agent can hand groups to sub-agents immediately.

### Visual CLI (TUI)
`vto ui` (alias `vto watch`) subscribes to the event stream:
- header: run kind, pool/mode, progress bar per project, ETA, pass/fail counters;
- live failure list (grouped), selectable while the run continues; details pane: message, diff,
  code frame of the failing line and of the project frame;
- keys: ↑↓ select, Enter details, `o` open in editor (`$VISUAL`/`$EDITOR`/`code -g file:line`),
  `r` re-run selected, `R` re-run all failed, `c` copy an AI-ready prompt for the selected
  failure, `a` send the group to the MCP task queue, `f` filter, `q` quit (run keeps going in daemon);
- works on Windows Terminal, macOS Terminal/iTerm2, Linux terminals; degrades to plain streaming
  output when not a TTY (CI) – failures printed immediately, summary at the end.

---

## Live coverage per source file (added: user requirement, basis for a VS Code extension)

Coverage is consumable incrementally, without waiting for the run to end.

### Events
After each test file finishes, the daemon merges its per-test hits into the live map and emits one
event per *source* file whose coverage changed:

```jsonc
{"ev":"coverage","runId":"r12","file":"src/Button.tsx","hash":"<content hash at record time>",
 "lines":{"covered":[3,4,5,9],"partial":[7],"uncovered":[8,12]},       // derived from blocks
 "branches":{"7":[1,0]},                                                 // per line: taken/not
 "testsByLine":{"5":["src/Button.test.tsx:42 > Button > disabled", "..."]}, // capped, see below
 "complete":false}                                                       // true after run-end
```
- `testsByLine` is capped (e.g. 20 ids per line, `more` counter); full lists via a request.
- `hash` lets clients drop coverage for an edited buffer (or map it via diff) instead of showing
  stale lines.
- Requests: `coverage { file }` (current merged state, also when no run is active),
  `tests_for { file, line }`, `lines_for { test }`.

### MCP
`coverage_of` gains `{ file, live: true }` → returns the current (possibly partial) coverage of a
file during a run; `tests_for_line { file, line }`.

### VS Code extension (planned, consumes the same IPC)
- Native Testing API integration: test tree from the map, run/debug buttons, **native coverage**
  (`TestRun.addCoverage` / `FileCoverage` with `StatementCoverage`/`BranchCoverage`) updated
  per file while the run progresses.
- Live failures as diagnostics + inline decorations at the failing line, peek with diff.
- Hover on a line: "covered by N tests" with links; CodeLens "run tests covering this function".
- On save: `run_affected` for that file (debounced), results streamed into the editor.
- Overlap / slow-test / unused-import hints as optional info diagnostics.
- Must coexist with the official Vitest extension (no duplicate runs; detect and offer to disable
  one, or act as a coverage/affected provider only).

---

## Savings measurement (added: user requirement, sales)

- Local, opt-out-free *but local-only* metrics log `.vto/metrics.jsonl` (no telemetry).
- Per run: tests run / total, CPU + wall, counterfactual full-run cost (same pool and baseline
  forks), MCP tokens returned vs. classic Vitest output tokens, time-to-first-failure.
- `vto savings` / MCP `savings_report`: runs avoided, test-minutes, CPU-hours, tokens saved.
- `vto ci-report`: per-pipeline JSON (duration, selected/total, pool, baseline) → CI cost.
- A separate interactive calculator (team size, runs/day, CI price/min, token price) turns
  measured ratios into money; formulas in mcp/SAVINGS.md, measured vs. estimated clearly split.
