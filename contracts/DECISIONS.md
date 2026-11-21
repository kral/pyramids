# vto contracts – binding decisions (WP1, 2026-11-21)

These rules apply to every package (analyzer, collector, daemon/MCP, vm-guard, TUI, verify).
Schemas and fixtures that pin them live next to this file (`raw-2.schema.json`,
`map-2.schema.json`, `fixtures/`). Where existing data differs, the "compatibility" line of
each section says what a reader must still accept.

Keywords: MUST / SHOULD as in RFC 2119.

---

## D1. Content hash

**Definition.** `contentHash(bytes)` = lower-case hex **SHA-256** (64 chars) of the file's bytes
after these two byte-level steps, in this order:

1. remove **one** leading UTF-8 BOM (`EF BB BF`) if present;
2. replace every `CR LF` (`0D 0A`) by `LF` (`0A`). A lone `CR` is kept.

No decoding, no Unicode normalisation, no trailing-newline handling, no truncation.

```js
// JS reference (collector, daemon): operate on a Buffer, never on a decoded string
export function contentHash(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  const out = Buffer.allocUnsafe(buf.length); let n = 0;
  for (let i = 0; i < buf.length; i++) { if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue; out[n++] = buf[i]; }
  return createHash('sha256').update(out.subarray(0, n)).digest('hex');
}
```

Rust reference: `vto::store::content_hash` (`analyzer/src/store.rs`).
Test vectors: `contracts/fixtures/hash-vectors.json` (every implementation MUST pass them).

**Why this one.**
- *SHA-256*: already the `file.sha256` field of the raw format; no collision questions in a tool
  whose answer is "safe to skip"; fast enough (429 files of the real-world suite ≈ 2 ms).
- *BOM and CRLF removed*: the same commit checked out with `core.autocrlf=true` (Git for Windows
  default) or saved by an editor that adds a BOM is the same program. Without this the map is
  "stale" for every file on Windows (REVIEW-2-architecture N3). ECMAScript itself normalises
  CRLF to LF inside template literals, so the two forms cannot behave differently as JS/TS.
- *Bytes, not text*: the result is defined for invalid UTF-8 and binary files and does not
  depend on a decoder's replacement behaviour. For valid UTF-8 it equals "SHA-256 of the UTF-8
  text after BOM removal and CRLF→LF" (the wording in REVIEW-2-architecture §2.3).
- *Lone CR kept, no NFC*: those change string contents; hashing them away could hide a real edit.

**Where it is used.**
- `file.sha256` in raw records and stored maps: hash of the ORIGINAL file as on disk (not the
  text after other Vite plugins).
- The analyzer compares it with the base-side git blob and with the working-tree file.
- The daemon's blob/version keys (`.vto/blobs`, `state.files[].sha`) MUST use it (replaces
  sha1-of-normText).
- Not used for: IPC endpoint keys, selection ids, block-table ids (any stable hash is fine there).

**Compatibility.** A reader comparing a recorded `sha256` with content MUST accept a match of
either `contentHash(bytes)` or plain `SHA-256(bytes)` (maps written before this decision). Both
prove equal content. The 16-hex `file.hash` field is deprecated: writers SHOULD stop emitting
it, readers MUST ignore it.

---

## D2. Root and path identity

1. **Canonical root = `realpath` of the project root** (`fs.realpathSync.native(root)`,
   Rust `std::fs::canonicalize`, with the Windows `\\?\` prefix removed and the drive letter
   upper-cased). Every tool canonicalises the root it is given (`--root`, cwd,
   `CLAUDE_PROJECT_DIR`, `VTO_ROOT`) **before** any comparison. `meta.root` is the canonical
   root with `/` separators.
2. **Path keys are root-relative**, `/` separators, no leading `./`, no `.`/`..` segments, no
   trailing `/`. A file is made relative by canonicalising it (realpath of the file, or of its
   nearest existing parent for deleted / not-yet-existing paths) and stripping the canonical
   root. Files outside the root keep an absolute canonical path with `/` separators
   (`C:/x/y` on Windows; UNC `//server/share/x`).
3. **Unicode: NFC.** Every path key is normalised to NFC when it is written and again when it is
   compared (git on macOS can hand out NFD names; readdir on APFS returns what was stored).
4. **Case policy: detected, not assumed.** Path keys are stored in the spelling the file system
   reports (case-preserving). Two keys are *the same file* when
   - they are byte-equal after NFC, or
   - the root's file system is case-insensitive and they are equal after NFC + Unicode
     lower-casing (`String.prototype.toLowerCase()` / Rust `str::to_lowercase`).

   Case-insensitivity is **probed per root**, never derived from `process.platform`:
   take an existing entry of the root whose name contains a letter (the root directory itself,
   else `package.json`, else the first such entry), flip the case of its name, and `stat` it. The
   file system is case-insensitive iff the flipped name resolves to the same file (same
   `dev`+`ino`; on Windows: exists). A probe that cannot decide ⇒ assume case-**sensitive** on
   POSIX, case-**insensitive** for drive-letter / UNC roots. The result MAY be cached per root
   for the life of the process.
5. **Root mismatch is never silent.** A reader that cannot place the map's paths under its root
   MUST answer "run all" (exit 3) or an error (exit 2) with a message naming both roots. It MUST
   NOT answer "0 tests selected". Test used by the analyzer: of the map's files (test files and
   modules, an even sample of at most 200) fewer than half exist below the reader's root.
6. Stored maps are **portable**: relative keys are resolved against the *reader's* canonical
   root, not against the recorded `meta.root` (CI caches restored into another work directory,
   `_work/1/s` vs `_work/2/s`).

Fixture: `contracts/fixtures/path-identity.json` (`a`, `b`, `caseInsensitive` → `same`).

**Compatibility.** Readers accept `\` separators, lower-case drive letters, absolute paths below
`meta.root` (format 2.0) and NFD spellings, and normalise them on load.

---

## D3. Exit codes (all command-line tools)

| code | name | meaning | who can return it |
|---|---|---|---|
| 0 | ok | the command did what was asked; for selection: the printed selection is complete (may be empty) | all |
| 1 | test failures | tests ran and at least one failed (genuine failures; includes FLAKY that was not explained) | `vto run*`, `vto-daemon run*`, `vm-guard run/check`, `verify` (a refuted claim) |
| 2 | usage / config error | bad arguments, missing or unreadable input (**a mistyped map path is 2, not 3**), unsupported format version, broken config, internal precondition | all |
| 3 | run all | the tool cannot give a safe selection: run the whole suite. Only for *valid* input that cannot answer (stale / inconsistent map, unknown files, config change, git error) | `vto affected`, `vto-daemon affected/run-affected` |
| 4 | new quarantine | the run changed the quarantine / conflict state (`incompatible.json`, `conflicts.json`): commit it and re-run | `vm-guard check/hunt/verify` (false red) |
| 5 | false green | a test passed in the fast mode and fails isolated: the fast mode's green cannot be trusted | `vm-guard verify`, `vto verify` gates |

Rules:
- Precedence when several apply: **5 > 1 > 4 > 3 > 2 > 0** is *not* used; a tool returns the
  first that occurs in its own flow, except that 5 always wins over 1 and 4, and 1 wins over 4.
- A selection command that exits 2 still prints the run-all sentinel of the requested format on
  stdout (`null`, `.\0`, `{"runAll":true,"error":true,…}`): a shell pipeline that drops the exit
  code must degrade to "run everything", never to "run nothing".
- Scripts MUST treat **any other non-zero code** (signals, panics = 101, Node crashes) as
  "failed, run all".
- `--help` and `--version` exit 0 and print to stdout. Usage errors print the message plus one
  line "see --help" to stderr (not the whole usage text).
- Legacy codes to remove: vm-guard `2 = NEW_QUARANTINE`, `3 = FALSE_GREEN`, `64 = USAGE`;
  `vto-daemon` `usage(64)`.

Machine-readable outputs carry the same information (`"runAll": true`, `"exit": 3`) so that an
agent never has to parse stderr.

---

## D4. Hardened git invocation

One function per language implements these rules; nothing else may spawn git.
Rust reference: `vto::git` (`analyzer/src/git.rs`). The daemon (WP3) MUST use the same rules
(port of that module, or call `vto affected --git …` and let the analyzer run git).

1. **Binary.** Resolve `git` (`git.exe` on Windows) once by walking `PATH`: skip relative
   entries, empty entries and the current directory; never use a shell, never `cmd /c`, never
   rely on Windows' implicit current-directory lookup. No executable from the project
   (`node_modules/.bin`, repo root) is ever a candidate. Spawn with an argv array.
2. **Fixed prefix on every call**, before the sub-command:
   ```
   git -C <canonical root>
       -c core.fsmonitor=false      -c core.hooksPath=/dev/null
       -c core.untrackedCache=false -c core.pager=cat
       -c diff.external=            -c core.quotePath=false
       -c diff.noprefix=false       -c diff.mnemonicPrefix=false
       -c diff.relative=false       -c diff.renames=false
       -c submodule.recurse=false   -c core.sshCommand=false
       -c credential.helper=        --no-pager
   ```
3. **Environment.** Set `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`; remove
   `GIT_EXTERNAL_DIFF`, `GIT_DIFF_OPTS`, `GIT_PAGER`, `PAGER`, `GIT_ASKPASS`, `GIT_SSH`,
   `GIT_SSH_COMMAND`, `GIT_CONFIG_COUNT` (+ `GIT_CONFIG_KEY_*`/`VALUE_*`), `GIT_CONFIG_PARAMETERS`,
   `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
   `GIT_ALTERNATE_OBJECT_DIRECTORIES`.
4. **Allowed sub-commands (read-only):** `rev-parse`, `diff`, `ls-files`, `cat-file`, `status`,
   `merge-base`. Never `fetch`, `checkout`, `stash`, `gc`, or anything that writes.
5. **Arguments.**
   - A user-supplied revision MUST match `^[A-Za-z0-9._/~^@{}-]{1,256}$` and MUST NOT start
     with `-`; it is first resolved with
     `rev-parse --verify --quiet --end-of-options <rev>^{commit}` and only the resulting 40/64-hex
     SHA is passed on.
   - `--end-of-options` before revisions, `--` before paths, on every call that takes them.
   - `diff`: always `--no-ext-diff --no-textconv --no-color --text --no-renames -U0
     --src-prefix=a/ --dst-prefix=b/ --ignore-submodules=none`. Renames are **not** detected:
     a rename is a deletion plus an addition (see D5.4).
   - Lists of paths are read with `-z` (`diff --name-status -z`, `ls-files -z`, `status
     --porcelain=v1 -z`) and split on NUL. Never parse C-quoted names from line output; never
     drop a name because it "looks odd": a name the tool cannot represent ⇒ run all.
   - `cat-file blob <sha>:<path>` takes the path relative to the git top level
     (`rev-parse --show-toplevel`, canonicalised like D2).
6. **Output.** Bounded: abort (⇒ run all) above 256 MiB of stdout. Text from git (names,
   stderr) is untrusted: sanitise control characters before printing, never interpret it.
7. **Failure.** Any git failure (not a repository, unknown base, shallow clone without the base,
   `safe.directory` refusal, timeout 60 s) ⇒ "run all" (exit 3) with the reason; never an empty
   diff.
8. **Trust boundary.** These rules neutralise what a checked-out *tree* can do
   (`.gitattributes`, `.gitmodules`, file names). `.git/config` of a hostile repository can still
   define `filter.<name>.clean` commands that `git diff` runs for matching paths; vto relies on
   git's `safe.directory` ownership check and MUST NOT add `safe.directory=*`.

---

## D5. Selection semantics shared by `vto affected` and the daemon

(Recorded here because WP2/WP3 depend on them; the full text is in FORMAT.md.)

1. **Filters are file-level by default.** `--vitest` prints `./path/to/x.test.ts`, one per
   selected test file. `file:line` filters are printed only with `--test-granularity` and never
   for a test file that changed, was renamed, or is selected as a whole.
2. **A changed, new or renamed test file is selected by its current path**, whether or not the
   map knows it. A new file counts as a test file when its name ends like a test file the map
   already has (`.test.ts`, `.spec.tsx`, … – so a Playwright `.spec.ts` in a project whose
   Vitest files are `.test.ts` is still an unknown file); it does not force "run all". A deleted
   test file is dropped from the selection.
3. **Ignore lists never beat the map.** A path matched by an ignore rule is skipped only when the
   map has no knowledge of it (not a test file, not in `fileload.modules`, not at or below a
   `fileload.reads` entry, not in `file` records).
4. **Renames = delete(old) + add(new).** Old path: handled as a deletion (loaders and readers
   selected). New path: handled as a new file. **A new file that is not a test file ⇒ run all**
   (a directory scan such as `import.meta.glob`, `require.context` or module-resolution
   shadowing can pick it up without any recorded edge).
5. **Line → block.** A changed line is block-local only when a block *strictly contains* it
   (starts on an earlier line and ends on a later line). Otherwise the line also holds module
   top-level code ⇒ every test file that loads the module.
6. **"Loads the module"** = test files whose `fileload.modules` contain it **or** that have any
   test hit / `fileload.hits` in it (covers lazily imported modules of older maps).
7. **Untrusted coverage ⇒ whole file.**
   - *Always selected* (also for an empty diff): test files with a test recorded as `fail`, with
     `fileload.error`, without a `fileload` record (when the map has fileloads at all), or listed
     in `meta.testFiles` without any test record. Their coverage is truncated or unknown, and a
     recorded failure is a failure until it is seen green.
   - *Selected as a whole when anything they load changed*: test files with a `skip`/`todo`,
     `tainted` or `leaky` test (a test skipped at collection has no coverage of its own).
8. **fs readers.** A test file is selected for every change when the collector says
   `fileload.readsComplete: false`, or has no `reads` record and the test source imports `fs`,
   or `readsComplete` is absent and the test source imports `child_process` /
   `worker_threads` / a process-spawning library, or uses fd-style / copy APIs that older
   collectors do not record.
9. **Map vs working tree.** The diff that selection uses is always *map commit → working tree*
   (`meta.gitHead`), whatever base the user named; the tool says so. A map commit the clone
   does not have ⇒ run all. A map recorded on a dirty tree is usable only when it lists
   `meta.dirtyFiles`; a listed file whose recorded hash equals the working-tree hash is
   unchanged since recording (whatever git reports), every other listed file is changed without
   line information. Independently, every file with a recorded `sha256` whose working-tree
   content differs although git reports no change (skip-worktree, ignored / generated files) is
   treated as changed.

### Additive format fields requested by these decisions (raw 2.1 → 2.2, all optional)

| record | field | writer | meaning |
|---|---|---|---|
| `fileload` | `readsComplete: boolean` | collector | `true`: every fs entry point incl. `open*`/FileHandle/`cp*`/`copyFile*`/`glob*`/`readlink*`/`realpath*`/`watch*` was wrapped **and** the test file started no child process / worker. `false`: something escaped. Absent: unknown (reader uses the source heuristics of D5.8) |
| `meta` | `dirtyFiles: ({path, sha256} \| string)[]` | collector runner | every path from `git status --porcelain=v1 -z --untracked-files=all` at record time (only when `dirty: true`, which then must also be true for untracked-only trees); `sha256` = D1 hash of the file as recorded, `null` if deleted. A bare string works only for files that have a `file` record with `sha256` |
| `meta` | `testFiles: string[]` | collector runner | every test file Vitest collected (root-relative), including files whose tests were all skipped or that failed to load |
| `meta` | `caseInsensitive: boolean` | collector runner | result of the D2.4 probe at record time (informative) |
| `test` | `state: "skip" \| "todo"` records | collector | one record per test skipped at collection (`skipIf`, `runIf`, `.skip`, `.todo`), without hits |
| `fileload` | `error: true` | collector | the test file failed to load / a `beforeAll` threw (coverage incomplete) |

Readers MUST ignore unknown fields and unknown record kinds (`t`) and MUST refuse a `meta.version`
above the one they implement.
