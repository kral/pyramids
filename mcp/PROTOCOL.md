# vto daemon IPC protocol – `vto-ipc/1`

The contract between the vto daemon and its clients: CLI (`vto-daemon`), MCP server (`vto-mcp`),
the TUI (`vto ui`, `/tui`) and the planned VS Code extension. Implementation: `src/ipc.mjs`
(transport, auth), `src/daemon.mjs` (subscriptions), `src/api.mjs` (methods), `src/engine.mjs` (events).
A mock daemon that speaks this protocol: `node dev/mock-events.mjs` (see the end of this file).

## 1. Versioning

- `protocol` (integer) is negotiated in `hello`. This document is protocol **1**.
- Within protocol 1 changes are **additive only**: new methods, new optional request fields, new
  result fields, new event types, new optional event fields. Clients **must ignore unknown fields
  and unknown events**. Removing/renaming anything, or changing a meaning, bumps the protocol.
- Every method result carries `v: "vto/1"` (result schema version, shared with the MCP tools).
- The daemon rejects a `hello` with a higher protocol than it speaks (`E_PROTOCOL`); a client that
  needs a newer feature checks `hello.protocol`.

## 2. Discovery and transport

One daemon per project root. The client computes the endpoint directory:

| OS | endpoint directory (per user, never shared) |
|---|---|
| Linux | `$XDG_RUNTIME_DIR/vto/<key>/` if that dir is owned by the user and `0700`, else `${XDG_CACHE_HOME:-~/.cache}/vto/run/<key>/` |
| macOS | `~/Library/Caches/vto/run/<key>/` (or `$XDG_CACHE_HOME/vto/run/<key>/`) |
| Windows | `%LOCALAPPDATA%\vto\run\<key>\` |

`<key>` = first 16 hex chars of `sha1(root)`, where `root` is the absolute project root with forward
slashes, **lower-cased when the filesystem is case-insensitive** (detected by stat-ing a case-flipped
path – APFS/NTFS are usually insensitive, ext4 is sensitive, but this is checked, not assumed).

`endpoint.json` in that directory (mode `0600`, written atomically by the daemon after `listen`):

```json
{"protocol":1,"pid":4242,"address":"/home/u/.cache/vto/run/7e09…/d.sock","token":"<64 hex>","root":"/home/u/proj","startedAt":"…"}
```

- POSIX: `address` is a Unix domain socket (`0600`) inside the `0700` endpoint dir. If that path is
  longer than 100 bytes (macOS `sun_path` = 104), the socket lives in a fresh `mkdtemp()` dir
  (`0700`) under `os.tmpdir()`; `endpoint.json` still sits in the private dir.
- Windows: `address` is a named pipe `\\.\pipe\vto-<32 random hex>` – a new random name per daemon start.
- Clients must verify (POSIX) that `endpoint.json` is owned by them and not group/other readable,
  and must check `pid` is alive before connecting.
- **Never TCP/HTTP.**

Lazy start: a client that finds no live daemon takes `start.lock` in the endpoint dir with
`O_CREAT|O_EXCL` (stale after 30 s or when the owner pid is dead), spawns
`node bin/vto-daemon.mjs serve <root>` detached, and polls `endpoint.json` (default 20 s).

## 3. Framing

UTF-8, one JSON object per line (`\n`). Max line length **1 MiB**: longer input closes the
connection after an `E_TOO_BIG` error.

- request: `{"id": 7, "method": "start_run", "params": {…}}` (`id`: integer chosen by the client)
- response: `{"id": 7, "result": {…}}` or `{"id": 7, "error": {"code": "E_USER", "message": "…"}}`
- event (only after `subscribe`): `{"ev": "failure", …}` – events never have an `id`

Error codes: `E_AUTH`, `E_PROTOCOL`, `E_PARSE`, `E_TOO_BIG`, `E_METHOD` (unknown method),
`E_USER` (invalid params, unknown run, nothing to run), `E_INTERNAL`.

## 4. Handshake and authentication

The first message must be `hello`; anything else closes the connection.

```json
→ {"id":1,"method":"hello","params":{"token":"<from endpoint.json>","protocol":1,"client":"vscode-vto/0.1"}}
← {"id":1,"result":{"protocol":1,"pid":4242,"root":"/home/u/proj"}}
```

The token is compared in constant time. Why a token on top of the private directory: Node cannot
set a DACL on a named pipe (libuv's default DACL grants *read* to Everyone), and on POSIX it guards
against mistakes with directory permissions. Peer-credential checks (`SO_PEERCRED`/`getpeereid`)
are not available in Node without a native addon – the 0700 directory + 0600 socket + token are the
controls (documented gap: SECURITY-REVIEW F2.1/F2.2).

## 5. Methods

All params are optional unless marked. Paths are relative to the root (forward slashes); paths that
resolve outside the root are rejected. Test ids: `file:line > full name` (`full name` = describe
chain joined by ` > `). Filters are typed objects – there is no way to pass Vitest CLI flags.

| method | params | result (summary) |
|---|---|---|
| `hello` | `token`*, `protocol`, `client` | `{protocol, pid, root}` |
| `status` | – | `{root, mode, pid, uptimeS, lanes{main,fix,clean}, lanePids, warm, pool, vitest, map{tests,testFiles,sourceFiles,gitHead,fullRunAt,dirtyTests,dirtyFiles,failing}, memoryMB, activeRun?, lastRun}` |
| `affected` | `base` (git ref), `limit`, `cursor` | `{count, total, runAll, reasons[], changed[], files[] (page), filesTotal, cursor?, notes?}` |
| `start_run` | `lane` (`main`\|`fix`\|`clean`, default: `fix` for `tests`/`failed` while a main run is active, `clean` when `instrumented:false`, else `main`); `kind`: `affected`\|`full`\|`tests`\|`failed`; `filters` [`{file?, line?, name?}`] (kind `tests`; `name` = literal substring); `ids` (kind `failed`); `base`; `bail`; `timeoutS` (≤3600); `instrumented` (false = no collector, map untouched) | `{runId, total, files, kind, lane, runAll, reasons[], status}` – returns immediately. An `affected` run queued behind another run is re-selected when it starts (the map changed meanwhile) |
| `wait_run` | `runId`, `timeoutS` | final run summary (below), or `run_status` when the timeout hits |
| `run_status` | `runId` (default: latest) | progress `{status, done, total, failed, files, filesTotal, elapsedMs, failureGroups}` or the final summary |
| `next_failures` | `runId`, `cursor` (opaque), `waitS` (≤30), `limit` (≤20) | long-poll: `{failures[], cursor, done, progress{done,total,failed,status}, moreOfSeenGroups?, moreGroups?}` |
| `cancel_run` | `runId`* | `{runId, status}` |
| `rerun_failed` | `runId` or `ids[]` (default: every failing test in the map), `lane` (`main`\|`fix`) | like `start_run`; **while a main run is active it runs in the `fix` lane immediately** (no waiting) |
| `enqueue_task` | `runId` + `group`, or `ids[]`; `note` | `{task}` – a failure group as a self-contained task for an agent (TUI key `a`) |
| `list_tasks` | `status` (`open`\|`claimed`\|`done`\|`dropped`\|`all`, default open), `limit`, `cursor` | `{tasks[]{taskId,status,group,count,error,claimedBy}, total}` |
| `claim_task` | `taskId` (default: oldest open), `agent` | `{task}` with `status: claimed` (atomic), or `{task: null}` |
| `complete_task` | `taskId`*, `status` (`done`\|`open` = release\|`dropped`), `note` | `{task{taskId,status}}` |
| `ci_summary` | `runId` | CI JSON (SAVINGS.md §4) |
| `why_failed` | `test`* (id or `file:line` prefix) | `{test, error, diff (≤80 lines), frames[≤10]{file,line,col,code}, source (±2 lines), otherErrors?, console? (deduped, ≤2 KB, redacted), coveredChanged[]}` |
| `coverage` | `file`*, `live` (default true), `detail`: `summary`\|`full`, `limit`, `cursor` | `{file, hash, editedSinceRecord, complete, runId, covered, partial, uncovered (range strings "3-5,9"), counts, testsByLine?, branches?}` |
| `tests_for` | `file`*, `line`*, `limit`, `cursor` | `{tests[] (page), total}` – live during a run |
| `lines_for` | `test`*, `limit`, `cursor` | `{test, files[]{file, blocks, lines}}` |
| `test_overlap` | `file` or `test` scope, `limit` (≤50), `cursor` | `{candidates[]{tier,…}, total}` – never the whole report |
| `slow_tests` | `file`, `limit`, `cursor` | `{withoutUniqueCoverage, totalMs, tests[]{id,ms,blocks}}` |
| `slow_imports` | `file` (test file → its unused imports), `limit`, `cursor` | `{modules[]{module,loadMsTotal,loadedBy,exercisedBy}, unusedImports?}` |
| `suggest_env` | `file` prefix, `limit`, `cursor` | `{candidates[]{file,env,tests}, probedFiles}` |
| `vm_guard_status` | – | `{enabled, mode, pool, quarantined{…}, conflicts, lastRun, dirtyStarts}` |
| `savings` | `since` (`30d`, `12h`, `90m`) | aggregate, see SAVINGS.md |
| `record_tokens` | `tool`, `tokens`, `runId` | `{ok}` (MCP server bookkeeping) |
| `subscribe` | `topics` (array of `run`, `test`, `coverage` and/or event names; default all), `replay` (default true: replays the active run's log), `coverageCap` (ids per line, 1–50, default 3) | `{subscribed, activeRun}` |
| `unsubscribe` | – | `{ok}` |
| `stop` | – | `{stopping: true}`; the daemon exits |

Every result also has `v`, `stale` (`staleReasons[]` when true) and `mapAgeS`.

**Run summary** (`wait_run`, final `run_status`):
`{runId, kind, status: done|cancelled|error, ran, passed, failed, skipped, total, ms, cpuMs?, firstFailureMs?, failures[≤5 groups], failureGroups?, moreFailureGroups?, fixedDuringRun?[], runAll, reasons?, instrumented, pool, mapUpdated{tests, files, dirty}, error?, timedOut?}`.
A compact failure: `{id, error (first line), diff (≤12 lines), at[≤3 "file:line"], src, group, sameErrorIn?, alsoIn?[≤3], changed?[], moreErrors?, fixedDuringRun?}`.

`cpuMs` is the lane process' own CPU (`process.cpuUsage`): it includes worker threads
(`threads`, `vmThreads`) but **not** child processes (`forks`, `vmForks`).

## 6. Events

Topics: `run` = `run-start`, `failure`, `progress`, `fix-rerun`, `run-end`, `task`; `test` = `file-start`,
`test`; `coverage` = `coverage`. Events of the active run are appended to `.vto/runs/<runId>.jsonl`
(partial `coverage` events are not persisted, final ones are). Events replayed after `subscribe`
carry `"replay": true`. All strings are redacted and stripped of control/bidi characters.

```jsonc
{"ev":"run-start","runId":"r12","kind":"affected|full|tests|failed","total":412,"files":38,"pool":"vm-guard:vm","lane":"main|fix|clean",
 "projects":{"dom":{"files":30,"tests":350},"node":{"files":8,"tests":62}}}
{"ev":"file-start","runId":"r12","file":"src/Button.test.tsx","project":""}
{"ev":"test","runId":"r12","id":"src/Button.test.tsx:42 > Button > disabled","state":"pass|fail|skip","ms":12}
{"ev":"failure","runId":"r12","seq":3,"id":"…","file":"src/Button.test.tsx","line":42,"name":"Button > disabled",
 "message":"AssertionError: …","diff":"…(≤40 lines)","frames":[{"file":"src/Button.tsx","line":17,"col":5,"code":"…"}],
 "group":"g-7a1c3e","coveredChanged":["src/Button.tsx:17"],"load":true?}
{"ev":"progress","runId":"r12","done":120,"failed":3,"etaMs":8400,"total":412,"files":11,"filesTotal":38}
{"ev":"fix-rerun","runId":"r12","id":"…","state":"pass|fail"}
{"ev":"coverage","runId":"r12","file":"src/Button.tsx","hash":"<sha1 of the version executed>",
 "lines":{"covered":[3,4,5,9],"partial":[7],"uncovered":[8,12]},"branches":{"7":[1,0]},
 "testsByLine":{"5":["src/Button.test.tsx:42 > Button > disabled"]},"more":{"5":17},"complete":false}
{"ev":"run-end","runId":"r12","passed":405,"failed":7,"skipped":0,"ms":21400,"cancelled":true?,"error":"…"?,"fixedDuringRun":2?}
{"ev":"task","action":"enqueued|claimed|done|released|dropped","task":{"taskId":"t3","group":"g-7a1c3e","count":12,"status":"open","claimedBy":"…"?}}
```

Notes against MCP.md (additive, same names):
- `run-start` is sent when the lane has resolved the specifications: `projects` maps each Vitest project
  name (`""` = root project) to its planned `files` and `tests` (tests from the selection; for full runs
  from the map, 0 for files the map does not know yet). Σ `projects[*].tests` = `total`. `lane` says
  which lane runs it; fix-lane runs (re-runs requested during a main run) are separate runs with their
  own `runId` and full event sequence. `file-start.project` lets clients attribute progress per project.
- `failure`: emitted from Vitest's `onTestCaseResult` (in Vitest 5.1.1 it fires ≈ immediately
  after the test, not at file end – measured). Load/collect errors of a file arrive as a failure
  with `line: 0`, `id: "<file>:0 > (load)"`, `load: true`; suite-hook errors as `"<file>:0 > (suite)"`.
  `seq` starts at 1 per run. `group` = `g-` + 6 hex of sha1(normalised first message line + first project frame file).
- `progress`: also `total` (can grow when the selection under-estimated), `files`, `filesTotal`.
  At most every 250 ms and after every test file.
- `fix-rerun`: the fix loop polls (≈0.7 s) the files covered by already-failed tests of the active run
  and re-runs those tests in a separate warm lane (`fix`, one worker) when their content changed.
- `coverage`: sent only while at least one subscriber wants `coverage`; per source file at most every
  300 ms (after a test file finished), and a final `complete: true` event per touched file at run end.
  `testsByLine` is capped (`coverageCap`), `more[line]` = ids not listed; use `tests_for` for the
  full list. Lines: the relevant blocks of line L are the innermost block containing L plus all
  blocks starting on L; all hit → covered, some → partial, none → uncovered; blank/comment/brace-only
  lines are omitted when the source of the recorded version is available. `hash` is the sha1 of the
  file content (BOM/CRLF-normalised) the run executed – a client with a different buffer hash must
  not paint these lines unmapped.
- `run-end` always comes last for a run; `cancelled`, `error`, `fixedDuringRun` are optional.

## 7. Example session

```
→ {"id":1,"method":"hello","params":{"token":"…","protocol":1,"client":"tui"}}
← {"id":1,"result":{"protocol":1,"pid":4242,"root":"/home/u/proj"}}
→ {"id":2,"method":"subscribe","params":{"topics":["run","coverage"]}}
← {"id":2,"result":{"subscribed":["run","coverage"],"activeRun":null}}
→ {"id":3,"method":"start_run","params":{"kind":"affected"}}
← {"id":3,"result":{"v":"vto/1","runId":"r7","total":64,"files":6,"kind":"affected","runAll":false,"reasons":[],"status":"queued","stale":false,"mapAgeS":12}}
← {"ev":"run-start","runId":"r7","kind":"affected","total":64,"files":6,"pool":"vm-guard:vm"}
← {"ev":"failure","runId":"r7","seq":1,…}
← {"ev":"coverage","runId":"r7","file":"src/Button.tsx",…,"complete":false}
← {"ev":"run-end","runId":"r7","passed":63,"failed":1,"skipped":0,"ms":2310}
```

## 8. Mock daemon for client development

```
node dev/mock-events.mjs --root <dir> [--speed 2] [--loop] [--tests 400] [--fail 7]
node dev/mock-events.mjs --root <dir> --replay <project>/.vto/runs/r12.jsonl   # replay a real run
```

It takes the endpoint slot of `<dir>` (stop a real daemon for that root first), implements
`hello`, `subscribe`, `status`, `run_status`, `next_failures`, `start_run`, `cancel_run`, `coverage`,
`stop`, and emits every event type above (incl. grouped failures, `fix-rerun` and `coverage`).

## 9. Environment classification file `.vm-guard/run/env.json` (format `vto-env/1`)

Written by the daemon after every instrumented run (and before a group-lane run); read by vm-guard
`mode: 'auto'`. Paths are relative to the project root with forward slashes. Entries of other producers
are kept; a measured entry is never replaced by a static one.

```json
{
  "format": "vto-env/1",
  "producer": "vto-daemon",
  "updatedAt": "2026-11-21T06:40:47.388Z",
  "files": {
    "tests/app/App.test.tsx":      { "group": "dom",  "source": "probe",  "env": "jsdom", "dom": true,  "at": "…" },
    "tests/game/hash.test.ts":     { "group": "node", "source": "probe",  "env": "node",  "dom": false, "at": "…" },
    "tests/util/format.test.ts":   { "group": "node", "source": "probe",  "env": "jsdom", "dom": false, "at": "…" },
    "tests/new/Thing.test.tsx":    { "group": "dom",  "source": "static", "at": "…" }
  }
}
```

- `source: "probe"`: measured by `src/collector-ext/setup-env-probe.mjs` (global DOM-access traps installed
  after the user's setup files + a MutationObserver on the document, so renders through references captured
  earlier – RTL `screen` – count). `env` = the configured environment of the file, `dom` = touched the DOM.
- `source: "static"` (no measurement yet): `.tsx`/`.jsx`, `@testing-library/`, `react-dom`, `document.`,
  `window.`, `screen.` or `@vitest-environment jsdom|happy-dom` → `dom`, otherwise `node`.
- `group` = `node` when the configured environment is not a DOM environment or the file never touched the DOM.

**Daemon lanes.** With `pool: "auto"` (default) the daemon keeps two warm main lanes, `dom` (default pool
vm-guard `vm`; configs with `test.projects` get `vmThreads` per project) and `node` (default `forks`), runs
them **in parallel** inside one run (one `runId`, merged events; `run-start.lane` is `main`, `pool` is
`dom:…+node:…`, `run-start.projects` keys are `<project>:<group>` or the group name for the root project,
the same strings as `file-start.project`; the run summary has `laneMs` per lane). Routing: a file goes to
the `node` lane when its **configured** environment is node; files that merely never touched the DOM move
there only with `nodeEnvironment: "node"` (their environment is switched to node in that lane). Worker
budget: `maxWorkers` (default cores − 1) split between the lanes by measured test time, ≥ 1 each.
Config keys: `groups` (`false` = one main lane), `groupPools` (`{"dom":"vm","node":"forks"}`; values `vm`,
`shared`, `forks`, `threads`, `vmThreads`, `vmForks`), `nodeEnvironment`, `maxWorkers`.
