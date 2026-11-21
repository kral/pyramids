# vto – consolidated fix list before 1.0

Sources: REVIEW-2-correctness.md (C-*), REVIEW-2-architecture.md (A-*), REVIEW-2-security.md (S-*),
REVIEW-2-usability.md (U-*), VALIDATION-real-suite.md, REVIEW-2-performance.md (P-*, pending).
Owner = the work package that fixes it (WP1–WP5 below). Status is tracked in the PR/commit, not here.

## P0 – wrong answers (false greens) – must fix before any pilot

| id | finding | owner |
|---|---|---|
| C-B1 | `affected --vitest` filters by recorded file:line → tests added to an existing file never run; line shifts / renamed test files error | WP1 |
| C-B2 | default ignore (`*.md`, `docs/**`) applied before recorded reads/modules → docs read via fs / `?raw` select 0 | WP1 |
| C-B3 | `fileload.modules` frozen at first beforeAll → `await import()`, lazy routes, resetModules+import not dependencies | WP2 |
| C-B4 | changed line with top-level data + nested arrow selects only arrow callers | WP1 |
| C-M2 | rename bypasses "new file → run all"; daemon ignores new non-test files | WP1 (CLI), WP3 (daemon) |
| C-M3 | test failing during collection keeps truncated coverage and is used for selection | WP1 + WP2 |
| C-M5 | tests skipped at collection (`skipIf`/`runIf`) can never be selected | WP1 + WP2 |
| C-M1 / S-N2 | fs reads via openSync/fd/FileHandle/copyFile/glob/child processes/workers invisible; the fs-importer fallback was disabled by reads tracking | WP2 (record) + WP1 (fallback when unknown) |
| A-1 | root through symlink/junction/subst → silent 0 selected (string prefix vs non-realpath root) | WP2 + WP1 + WP3 |
| U-7 | Windows: URL reads `/C:/…` dropped, case-sensitive module filter, no realpath root | WP2 |
| S-N2b | daemon base diff drops git-quoted file names (diacritics) | WP3 |
| A-2 | clean (uninstrumented) lane marks every passing test dirty | WP3 |
| C-M4 | daemon stored map drops `reads`; missed edit forgotten after version advance | WP3 |
| C-M6 | vitest-guard shared: order-dependent false greens not caught by verify --sample all | WP4 |
| C-M7 | vitest-guard check labels deterministic vm-only failure FLAKY, exit 0 | WP4 |
| U-2 | vitest-guard check/compare silently run forks when config not wrapped → wrong modes.json | WP4 |
| C-M8 | verify "confirmed" for tests differing by a sign literal; pairs not listed | WP5 |

## P0 – security

| id | finding | owner |
|---|---|---|
| S-N1 | "read-only" MCP tools run repo-controlled binaries (analyzer from project node_modules); daemon git not hardened (fsmonitor); Windows CWD binary lookup | WP3 (+WP1 git driver reuse) |
| S-N4 | TUI `o` opens any path with OS default handler (executes on Windows) | WP5 |
| S-N5 | writes follow committed symlinks in `.vto/` | WP3 |
| S-N3 | AI prompt in TUI forgeable (fake sections, fence break, escapes to clipboard); OSC links from run logs | WP5 |
| S-N6/N7 | tasks.json unredacted; missing token patterns; Unicode tag chars / U+2028 reach agents; why_failed lookup with escaped ids | WP3 |
| S-N8 | IPC: no handshake timeout, non-string token crash, client name log forging | WP3 |
| S-F10 | verify report-md escapes only `|` | WP5 |
| S-F11 | `.vto/` world-readable; samples/demo-raw contains full source + absolute paths | WP3 + WP5 |
| U-3 | `npx vitest-guard` / `vto` names taken on npm (docs fixed in 61dcfbf); need scoped names | WP5 |

## P1 – consistency, structure, install

| id | finding | owner |
|---|---|---|
| A-5 | three content-hash definitions; CRLF/BOM → stale on Windows | WP1 defines, WP2/WP3 adopt |
| A-6 / S-N9 | env.json two writers, different merge rules, no lock → single owner/merge function | WP4 owns; WP3 calls it |
| A-7 | no single source of truth for formats (raw, stored map, env, sig, ipc) → JSON Schemas + golden fixtures in `contracts/` | WP1 (raw/map), WP3 (ipc/env) |
| A-8 | engine.mjs 1050-line class; lock stale-takeover race; no memory budget for warm lanes | WP3 |
| A-9 | daemon map keyed by absolute case-exact paths → root-relative, case policy | WP3 |
| U-5 | `affected` run-all on dirty tree / new commit in normal local use; daemon disagrees → one engine, clear hints | WP1 + WP3 |
| U-6 | daemon silently changes pool (auto → vm) → never change pool without explicit config; print pool every run | WP3 |
| U-11 | mistyped map path → exit 3 instead of error; `\u{a}` in usage; HTML entities in names; huge report | WP1 |
| A-10 / U-4 | engines/peer ranges wrong; private packages; no LICENSE; Rust hidden prerequisite; no install docs | WP5 (LICENSE needs owner decision) |
| A-4 / U-9 | CI never ran, covers 2/6 packages, macos-13 retired, skip counted as pass | WP5 |
| U-10 | docs contradict validation numbers | WP5 |
| U-8 | fragmented CLI, exit codes, env var names, no --version | WP5 (design + thin `vto` dispatcher) |
| A-3 | 44 Vitest-internal touch points, 11 silent → adapter with capability probes | later (after P0), WP2 drafts |

## Work packages (file ownership – do not edit outside your package; ask the coordinator)

- **WP1 analyzer & selection** – `analyzer/**`, `FORMAT.md`, `contracts/raw*`, `contracts/map*`
- **WP2 collector** – `collector/**` (except `collector/corpus/cases` additions are fine), `vitest-overlap.mjs`
- **WP3 daemon & MCP** – `mcp/**`, `MCP.md`, `contracts/ipc*`, `contracts/env*` (schema only)
- **WP4 vitest-guard** – `vitest-guard/**`
- **WP5 TUI, verify, CI, packaging, docs** – `tui/**`, `verify/**`, `.github/**`, root `package.json`, `README*.md`, `ARCHITECTURE.md` (status notes only), `samples/**`, new `LICENSE`/`SECURITY.md` (after owner decision)

## Performance (REVIEW-2-performance.md) – added after WP launch

| id | finding | owner |
|---|---|---|
| P-1 | analyzer subset search quadratic in time+memory (app-shell 30k: 23 s, 2.47 GB); `.iter().copied()` fix → 184 MB; needs size pre-filter + candidate budget | WP1 |
| P-7 | set cover superlinear; sorted-list gain 1480 → 60 ms (prototype in /home/claude/review2-perf/analyzer-patched) | WP1 |
| P-2 | live coverage events recompute over all tests hitting a file (32 ms/event at 30k) → incremental totals | WP3 |
| P-3/P-4 | daemon regenerates whole report on first query; re-reads 48 MB map per selection | WP3 |
| P-5 | no cleanup of `.vto/` blobs, metrics, lane logs → retention/rotation | WP3 |
| P-6 | run where no worker starts reports green (`ran 0, failed 0`) | WP3 (+WP4 for vitest-guard runner) |
| P-8 | perf claims without data in repo → commit `perf/data/` with raw measurements; collector overhead under vm pools is +12 %, not ~3 % | WP5 (docs) |

## Windows: native crash under a non-ASCII path (open)

`collector/test/collector.test.mjs` exits with `0xC0000409` (STATUS_STACK_BUFFER_OVERRUN) about 0.4 s after start when the
repository lives in a directory with diacritics (`Můj projekt ěš`, CI job "path with a space and diacritics (windows-2025)").
The same file passes in the normal Windows path. No subtest starts, so the crash is at module load; the suspect is a
native addon (oxc-parser binding) loaded from a non-ASCII path. Next step: reproduce with a bare
`node -e "import('oxc-parser')"` from that directory, then report upstream or fall back to the wasm build.
