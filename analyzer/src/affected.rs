//! `vto affected`: unified diff (base → working tree) → tests that may be affected.
//!
//! The coverage map was recorded on the base commit, so hunks are mapped with their OLD side:
//! - changed / deleted old line L → every block overlapping L (default). `innermost` (unsafe,
//!   experimental) keeps only blocks that contain no other block containing L.
//! - pure insertion between old lines p and p+1 → blocks spanning that gap.
//! - a change outside every block, or in a block that ran at import time / in beforeAll
//!   (`fileload.hits`), or in a module without blocks → every test of every test file whose
//!   `fileload.modules` contains the file. Without fileload data → run all.
//! - deleted file → as above for the whole file. Changed test file → all its tests.
//!   Snapshot `__snapshots__/x.test.ts.snap` → tests of `x.test.ts`.
//! - ignored paths (default `*.md`, `docs/**`) are skipped; "run all" triggers (package.json,
//!   lockfiles, vite/vitest config, tsconfig, .env*, setup files) and files unknown to the map
//!   (new files, non-instrumented files) ⇒ run all (exit 3).

use crate::model::Model;
use crate::paths;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct FileChange {
    pub old: Option<String>,
    pub new: Option<String>,
    /// changed or deleted old lines (1-based)
    pub changed: Vec<u32>,
    /// pure insertions after old line p (0 = before the first line)
    pub inserted_after: Vec<u32>,
}

/// Git C-style quoted path ("a\\303\\251.ts") → UTF-8 string.
pub fn unquote(p: &str) -> String {
    let Some(inner) = p.strip_prefix('"').and_then(|x| x.strip_suffix('"')) else { return p.to_string() };
    let b = inner.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 1 < b.len() {
            let c = b[i + 1];
            if (b'0'..=b'3').contains(&c) && i + 4 <= b.len() {
                let oct = std::str::from_utf8(&b[i + 1..i + 4]).unwrap_or("x");
                if let Ok(v) = u8::from_str_radix(oct, 8) {
                    out.push(v);
                    i += 4;
                    continue;
                }
            }
            out.push(match c {
                b'n' => b'\n',
                b't' => b'\t',
                b'r' => b'\r',
                b'a' => 7,
                b'b' => 8,
                b'f' => 12,
                b'v' => 11,
                other => other,
            });
            i += 2;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn strip_path(p: &str) -> Option<String> {
    let p = if p.starts_with('"') { p.trim_end() } else { p.split('\t').next().unwrap_or(p).trim_end() };
    let p = unquote(p);
    let p = p.as_str();
    if p == "/dev/null" {
        return None;
    }
    let p = p.strip_prefix("a/").or_else(|| p.strip_prefix("b/")).unwrap_or(p);
    Some(p.replace('\\', "/"))
}

fn parse_range(s: &str) -> (u32, u32) {
    let s = &s[1..];
    match s.split_once(',') {
        Some((a, b)) => (a.parse().unwrap_or(0), b.parse().unwrap_or(0)),
        None => (s.parse().unwrap_or(0), 1),
    }
}

pub fn parse_diff(text: &str) -> Vec<FileChange> {
    let mut out: Vec<FileChange> = Vec::new();
    let mut cur: Option<FileChange> = None;
    let (mut old_rem, mut new_rem) = (0u32, 0u32);
    let mut old_line = 0u32;
    let mut prev_minus = false;
    let flush = |cur: &mut Option<FileChange>, out: &mut Vec<FileChange>| {
        if let Some(c) = cur.take() {
            if c.old.is_some() || c.new.is_some() {
                out.push(c);
            }
        }
    };
    for line in text.lines() {
        if old_rem > 0 || new_rem > 0 {
            let (tag, _) = line.split_at(line.len().min(1));
            match tag {
                "-" => {
                    if let Some(c) = cur.as_mut() {
                        c.changed.push(old_line);
                    }
                    old_line += 1;
                    old_rem = old_rem.saturating_sub(1);
                    prev_minus = true;
                }
                "+" => {
                    if !prev_minus {
                        if let Some(c) = cur.as_mut() {
                            if c.inserted_after.last() != Some(&(old_line - 1)) {
                                c.inserted_after.push(old_line - 1);
                            }
                        }
                    }
                    new_rem = new_rem.saturating_sub(1);
                }
                "\\" => {}
                _ => {
                    // context (" " or empty line in sloppy diffs)
                    old_line += 1;
                    old_rem = old_rem.saturating_sub(1);
                    new_rem = new_rem.saturating_sub(1);
                    prev_minus = false;
                }
            }
            continue;
        }
        if line.starts_with("diff --git ") {
            flush(&mut cur, &mut out);
            cur = Some(FileChange::default());
            // fallback paths from the header (used for pure renames / mode changes)
            let rest = &line[11..];
            if let Some((a, b)) = rest.split_once(" b/") {
                let c = cur.as_mut().unwrap();
                c.old = strip_path(a);
                c.new = strip_path(b);
            }
        } else if let Some(p) = line.strip_prefix("--- ") {
            if cur.as_ref().is_some_and(|c| !c.changed.is_empty() || !c.inserted_after.is_empty()) || cur.is_none() {
                flush(&mut cur, &mut out);
                cur = Some(FileChange::default());
            }
            cur.as_mut().unwrap().old = strip_path(p);
        } else if let Some(p) = line.strip_prefix("+++ ") {
            if let Some(c) = cur.as_mut() {
                c.new = strip_path(p);
            }
        } else if let Some(h) = line.strip_prefix("@@ ") {
            let mut it = h.split_whitespace();
            let (a, b) = parse_range(it.next().unwrap_or("-0,0"));
            let (_, d) = parse_range(it.next().unwrap_or("+0,0"));
            old_rem = b;
            new_rem = d;
            old_line = if b == 0 { a + 1 } else { a };
            prev_minus = false;
        }
    }
    flush(&mut cur, &mut out);
    out
}

/// One selected test file (the unit of `--vitest` filters).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelFile {
    /// current display path (root-relative); for a renamed / new test file the NEW path
    pub path: String,
    /// every test of the file must run (changed / new test file, fs reader, loader of a changed
    /// module, untrusted coverage, or default file granularity). `false` only with
    /// `test_granularity` when single tests were matched through block hits.
    pub whole: bool,
    /// the map has test records of this file
    pub known: bool,
}

#[derive(Debug, Default)]
pub struct Affected {
    /// unit indices, sorted (tests the map knows; new tests of selected files are not in the map)
    pub units: Vec<usize>,
    /// selected test files, sorted by path – THE selection (`units` is informative)
    pub files: Vec<SelFile>,
    /// reasons why everything must run (exit 3)
    pub run_all: Vec<String>,
    pub notes: Vec<String>,
    pub ignored: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AffectedOpts {
    pub innermost: bool,
    /// root-relative paths whose base-side content does not match the recorded hash
    pub stale: Vec<String>,
    /// additionally select every test file importing a changed module (≈ `vitest related`;
    /// also catches edits that make the module fail to load, e.g. syntax errors)
    pub importers: bool,
    /// ordered gitignore-like rules: the last matching pattern wins, `!pattern` re-includes
    pub ignore: Vec<String>,
    pub run_all: Vec<String>,
    /// select only the matching tests instead of whole test files (opt-in; unsafe with
    /// order-dependent coverage such as module-level memo caches, VALIDATION A2)
    pub test_granularity: bool,
    /// folded test-file keys whose file-system inputs are not (completely) recorded – fs users
    /// without `fileload.reads`, `readsComplete: false`, child processes / workers, fd-style
    /// reads (contracts/DECISIONS.md D5.8). Fallback: selected for every change.
    pub fs_readers: Vec<String>,
}

/// `.vitest-guard/` holds volatile run state (durations, pollution, plans, caches) – ignored, except the
/// two files that change which tests can run together.
pub const DEFAULT_IGNORE: &[&str] = &[
    "*.md",
    "docs/**",
    ".vitest-guard/**",
    "!.vitest-guard/incompatible.json",
    "!.vitest-guard/conflicts.json",
];

/// gitignore-like evaluation of an ordered rule list (last match wins, `!` negates).
pub fn is_ignored(rules: &[String], path: &str) -> bool {
    let mut ign = false;
    for r in rules {
        match r.strip_prefix('!') {
            Some(neg) => {
                if glob_match(neg, path) {
                    ign = false;
                }
            }
            None => {
                if glob_match(r, path) {
                    ign = true;
                }
            }
        }
    }
    ign
}
pub const DEFAULT_RUN_ALL: &[&str] = &[
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    ".yarnrc.yml",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "bun.lock",
    "bun.lockb",
    ".npmrc",
    "vitest.config.*",
    "vitest.*.config.*",
    "vitest.workspace.*",
    "vite.config.*",
    "vite.*.config.*",
    "tsconfig*.json",
    "jsconfig*.json",
    ".env*",
    "*.setup.*",
    "setupTests.*",
    "vitest.setup.*",
    "babel.config.*",
    ".babelrc*",
    "postcss.config.*",
    ".gitattributes",
    ".gitmodules",
    ".vto/**",
    ".vitest-guard/incompatible.json",
    ".vitest-guard/conflicts.json",
    "**/__mocks__/**",
    "vitest.*",
    ".nvmrc",
    ".node-version",
];

impl Default for AffectedOpts {
    fn default() -> Self {
        AffectedOpts {
            innermost: false,
            stale: Vec::new(),
            test_granularity: false,
            fs_readers: Vec::new(),
            importers: false,
            ignore: DEFAULT_IGNORE.iter().map(|s| s.to_string()).collect(),
            run_all: DEFAULT_RUN_ALL.iter().map(|s| s.to_string()).collect(),
        }
    }
}

/// Minimal glob: `**` (any, incl. '/'), `**/` (zero or more directories), `*` (no '/'), `?`,
/// `{a,b}`. A pattern without '/' matches the basename at any depth; otherwise the whole path
/// (leading "./" or "/" ignored). Linear-time DP over (pattern token × path byte) – no
/// backtracking, so patterns like `**a**a**a**b` cannot blow up (SECURITY-REVIEW F15).
/// Brace expansion is capped at 64 alternatives (beyond that the pattern never matches).
pub fn glob_match(pat: &str, path: &str) -> bool {
    let mut alts = vec![pat.to_string()];
    loop {
        let mut next = Vec::new();
        let mut expanded = false;
        for a in &alts {
            if let (Some(open), Some(close)) = (a.find('{'), a.find('}')) {
                if close > open {
                    expanded = true;
                    for alt in a[open + 1..close].split(',') {
                        next.push(format!("{}{}{}", &a[..open], alt, &a[close + 1..]));
                    }
                    continue;
                }
            }
            next.push(a.clone());
        }
        if next.len() > 64 {
            return false;
        }
        alts = next;
        if !expanded {
            break;
        }
    }
    alts.iter().any(|p| glob_one(p, path))
}

#[derive(Clone, Copy, PartialEq)]
enum Tok {
    Lit(u8),
    Q,
    Star,
    DStar,
    DStarSlash,
}

fn glob_one(pat: &str, path: &str) -> bool {
    let pat = pat.trim_start_matches("./").trim_start_matches('/');
    let path = path.trim_start_matches("./").trim_start_matches('/');
    let target = if pat.contains('/') { path } else { path.rsplit('/').next().unwrap_or(path) };
    let p = pat.as_bytes();
    let mut toks = Vec::with_capacity(p.len());
    let mut i = 0;
    while i < p.len() {
        if p[i] == b'*' && p.get(i + 1) == Some(&b'*') {
            let mut k = i;
            while k < p.len() && p[k] == b'*' {
                k += 1;
            }
            if p.get(k) == Some(&b'/') {
                toks.push(Tok::DStarSlash);
                k += 1;
            } else {
                toks.push(Tok::DStar);
            }
            i = k;
        } else {
            toks.push(match p[i] {
                b'*' => Tok::Star,
                b'?' => Tok::Q,
                c => Tok::Lit(c),
            });
            i += 1;
        }
        // collapse runs of stars (`*` after `**` is redundant)
        while toks.len() >= 2 && matches!(toks[toks.len() - 1], Tok::Star | Tok::DStar) && toks[toks.len() - 2] == Tok::DStar {
            toks.pop();
        }
    }
    let s = target.as_bytes();
    let n = s.len();
    let mut cur = vec![false; n + 1];
    cur[0] = true;
    let mut nxt = vec![false; n + 1];
    for t in toks {
        nxt.iter_mut().for_each(|x| *x = false);
        match t {
            Tok::Lit(c) => {
                for j in 0..n {
                    nxt[j + 1] = cur[j] && s[j] == c;
                }
            }
            Tok::Q => {
                for j in 0..n {
                    nxt[j + 1] = cur[j] && s[j] != b'/';
                }
            }
            Tok::Star => {
                let mut run = false;
                for j in 0..=n {
                    if j > 0 && s[j - 1] == b'/' {
                        run = false;
                    }
                    run |= cur[j];
                    nxt[j] = run;
                }
            }
            Tok::DStar => {
                let mut run = false;
                for j in 0..=n {
                    run |= cur[j];
                    nxt[j] = run;
                }
            }
            Tok::DStarSlash => {
                // zero directories, or any run of whole "dir/" segments
                let mut run = false;
                for j in 0..=n {
                    if cur[j] {
                        nxt[j] = true;
                        if j == 0 || s[j - 1] == b'/' {
                            run = true;
                        }
                    }
                    if run && j > 0 && s[j - 1] == b'/' {
                        nxt[j] = true;
                    }
                }
            }
        }
        std::mem::swap(&mut cur, &mut nxt);
        if !cur.iter().any(|&x| x) {
            return false;
        }
    }
    cur[n]
}

fn innermost(cands: &[(usize, (u32, u32))]) -> Vec<usize> {
    cands
        .iter()
        .filter(|(_, c)| !cands.iter().any(|(_, d)| d != c && d.0 >= c.0 && d.1 <= c.1))
        .map(|x| x.0)
        .collect()
}

/// `x.test.ts` → `.test.ts`, `a/b.spec.tsx` → `.spec.tsx` (the part of the basename that makes
/// a file a test file by naming convention).
pub fn test_suffix(p: &str) -> Option<&str> {
    let base = p.rsplit('/').next().unwrap_or(p);
    let i = base.find(".test.").or_else(|| base.find(".spec."))?;
    let suf = &base[i..];
    let ext = suf.rsplit('.').next().unwrap_or("");
    matches!(ext, "ts" | "tsx" | "js" | "jsx" | "mts" | "cts" | "mjs" | "cjs").then_some(suf)
}

/// `changes` paths must already be relative to the analysis root.
pub fn affected(model: &Model, changes: &[FileChange], o: &AffectedOpts) -> Affected {
    use std::collections::{BTreeMap, HashSet};
    let mut res = Affected::default();
    let fold = |p: &str| paths::fold_key(p, model.windows);
    let mut by_file: Vec<Vec<usize>> = vec![Vec::new(); model.files.len()];
    for (i, it) in model.items.iter().enumerate() {
        if it.span.0 > 0 {
            by_file[it.file as usize].push(i);
        }
    }
    // fail-safe preconditions (SECURITY-REVIEW F7): an inconsistent map selects nothing reliably
    if !model.integrity.is_empty() {
        for p in &model.integrity {
            res.run_all.push(format!("raw data integrity: {p}"));
        }
        return res;
    }
    // EXACT path matching only (F6: `vendor/src/price.ts` must never map onto `src/price.ts`)
    let file_idx = model.file_index();
    let find = |p: &str| -> Option<usize> { file_idx.get(&fold(p)).copied() };
    // test files of the map: key → display path. `meta.testFiles` adds collected files without
    // any test record (all tests skipped, or the file failed to load).
    let mut test_display: BTreeMap<String, String> = BTreeMap::new();
    for u in &model.units {
        test_display.entry(u.file_key().to_string()).or_insert_with(|| u.file.clone());
    }
    let with_units: HashSet<String> = test_display.keys().cloned().collect();
    for t in &model.test_files {
        test_display.entry(fold(t)).or_insert_with(|| t.clone());
    }
    let find_test = |p: &str| -> Option<String> {
        let k = fold(p);
        test_display.contains_key(&k).then_some(k)
    };
    // naming conventions of the map's own test files: a NEW file is taken for a test file only
    // when it is named like the tests the map already has (`.test.ts` ≠ a Playwright `.spec.ts`)
    let known_suffixes: HashSet<String> = test_display.keys().filter_map(|k| test_suffix(k)).map(|s| s.to_lowercase()).collect();
    let is_new_test = |p: &str| test_suffix(p).is_some_and(|s| known_suffixes.contains(&s.to_lowercase()));
    // which files does any test hit / any fileload contain (map consistency)
    let mut hit_any = vec![false; model.files.len()];
    for u in &model.units {
        for &i in &u.items {
            hit_any[model.items[i as usize].file as usize] = true;
        }
    }
    let mut loaded_any = vec![false; model.files.len()];
    for fl in &model.fileloads {
        for &m in &fl.modules {
            loaded_any[m as usize] = true;
        }
    }
    let stale: HashSet<String> = o.stale.iter().map(|s| fold(s)).collect();
    let import_set: HashSet<u32> = model.import_items.iter().copied().collect();
    let setup_keys: Vec<String> = model.setup_files.iter().map(|s| fold(s)).collect();
    let reads_folded: Vec<Option<Vec<String>>> =
        model.fileloads.iter().map(|fl| fl.reads.as_ref().map(|rd| rd.iter().map(|r| fold(r)).collect())).collect();
    let readers_of = |p: &str| -> Vec<usize> {
        let p = fold(p);
        let mut v = Vec::new();
        for (i, rd) in reads_folded.iter().enumerate() {
            if rd.as_ref().is_some_and(|rd| rd.iter().any(|r| r.is_empty() || r == "." || p == *r || p.starts_with(&format!("{r}/")))) {
                v.push(i);
            }
        }
        v
    };

    // C-M2: a rename is a deletion of the old path plus a new file at the new path
    let mut split: Vec<FileChange> = Vec::with_capacity(changes.len());
    for ch in changes {
        match (&ch.old, &ch.new) {
            (Some(a), Some(b)) if fold(a) != fold(b) => {
                res.notes.push(format!("{a} → {b}: rename handled as deletion + new file"));
                split.push(FileChange { old: Some(a.clone()), new: None, ..Default::default() });
                split.push(FileChange { old: None, new: Some(b.clone()), ..Default::default() });
            }
            _ => split.push(ch.clone()),
        }
    }

    let mut sel_items = vec![false; model.items.len()];
    let mut loaders_of: Vec<usize> = Vec::new(); // files whose loaders must all run
    let mut changed_modules: Vec<usize> = Vec::new(); // every changed file the map knows as a module
    // whole test files: folded key → display path (current)
    let mut whole: BTreeMap<String, String> = BTreeMap::new();
    let mut new_tests: BTreeMap<String, String> = BTreeMap::new();
    let mut deleted_tests: HashSet<String> = HashSet::new();
    let disp = |k: &str| test_display.get(k).cloned().unwrap_or_else(|| k.to_string());
    for ch in &split {
        let paths_: Vec<&str> = ch.old.iter().chain(ch.new.iter()).map(|s| s.as_str()).collect();
        let path = paths_[0];
        let readers: Vec<usize> = {
            let mut v: Vec<usize> = paths_.iter().flat_map(|p| readers_of(p)).collect();
            v.sort_unstable();
            v.dedup();
            v
        };
        let read_hit = !readers.is_empty();
        // C-B2: the ignore list never beats the map. A path is skipped only when the map knows
        // nothing about it (no test file, no module, no recorded fs read at or above it).
        let known = read_hit || paths_.iter().any(|p| find(p).is_some() || find_test(p).is_some());
        if paths_.iter().all(|p| is_ignored(&o.ignore, p)) {
            if !known {
                res.ignored.push(path.to_string());
                continue;
            }
            res.notes.push(format!("{path}: matches an ignore rule, but the coverage map depends on it → not ignored"));
        }
        for &r in &readers {
            let k = &model.fileloads[r].test_file;
            whole.insert(k.clone(), disp(k));
        }
        if let Some(p) = paths_.iter().find(|p| {
            o.run_all.iter().any(|g| glob_match(g, p)) || setup_keys.iter().any(|s| *s == fold(p) || s.ends_with(&format!("/{}", fold(p))))
        }) {
            res.run_all.push(format!("{p}: configuration / dependency / setup / attributes file changed"));
            continue;
        }
        // snapshot → its test file
        if let Some(snap) = path.strip_suffix(".snap").filter(|p| p.contains("__snapshots__/")) {
            let tf = snap.replacen("__snapshots__/", "", 1);
            match find_test(&tf) {
                Some(t) => {
                    whole.insert(t.clone(), disp(&t));
                }
                None if is_new_test(&tf) => {
                    new_tests.insert(fold(&tf), tf.clone());
                }
                None => res.run_all.push(format!("{path}: snapshot of an unknown test file")),
            }
            continue;
        }
        let Some(old) = ch.old.as_deref() else {
            // new file: not in the base map
            let new = ch.new.as_deref().unwrap_or("?");
            if let Some(t) = find_test(new) {
                whole.insert(t, new.to_string());
            } else if is_new_test(new) {
                // C-B1: a new (or renamed) test file is selected by its current path
                res.notes.push(format!("{new}: new test file → selected by path"));
                new_tests.insert(fold(new), new.to_string());
            } else {
                res.run_all.push(format!("{new}: new file, unknown to the coverage map"));
            }
            continue;
        };
        if let Some(t) = find_test(old) {
            if ch.new.is_none() {
                res.notes.push(format!("{old}: test file deleted"));
                whole.remove(&t);
                deleted_tests.insert(t);
            } else {
                whole.insert(t, old.to_string());
            }
            continue;
        }
        let Some(fi) = find(old) else {
            if read_hit {
                // a non-module file (CSS, text, fixture) that tests read through node:fs
                res.notes.push(format!("{old}: read via node:fs by the selected test files"));
            } else if ch.new.is_none() && is_new_test(old) {
                res.notes.push(format!("{old}: test file unknown to the map deleted"));
            } else {
                res.run_all.push(format!("{old}: not in the coverage map"));
            }
            continue;
        };
        changed_modules.push(fi);
        if !model.fileloads.is_empty() && !loaded_any[fi] && !hit_any[fi] && !read_hit {
            // a recorded module that no test file loaded and no test hit: contradictory (poisoned
            // or truncated map) – refuse instead of selecting nothing
            res.run_all.push(format!("{old}: in the map but loaded by no test file – inconsistent map"));
            continue;
        }
        let blocks = &by_file[fi];
        let no_hunks = ch.changed.is_empty() && ch.inserted_after.is_empty();
        let why = if ch.new.is_none() {
            Some("deleted")
        } else if blocks.is_empty() {
            Some("module without blocks")
        } else if stale.contains(&fold(old)) {
            Some("content differs from the recorded hash (stale map)")
        } else if no_hunks {
            Some("changed without line information (binary / -diff / mode change)")
        } else {
            None
        };
        if let Some(why) = why {
            res.notes.push(format!("{old}: {why} → every test file loading it"));
            loaders_of.push(fi);
            for &b in blocks {
                sel_items[b] = true;
            }
            continue;
        }
        let span = |i: usize| model.items[i].span;
        let mut file_level = false;
        // `local` = some block strictly contains the changed text (C-B4, D5.5): only then is the
        // change invisible to module top-level code that shares the line.
        let mut pick = |c: Vec<(usize, (u32, u32))>, local: bool, what: String, file_level: &mut bool| {
            if !local {
                if !*file_level {
                    let how = if c.is_empty() { "outside any block (top level)" } else { "shares its line with top-level code (no block contains the whole line)" };
                    res.notes.push(format!("{old}: {what} {how} → every test file loading it"));
                }
                *file_level = true;
            }
            let sel = if o.innermost && local { innermost(&c) } else { c.iter().map(|x| x.0).collect() };
            for b in sel {
                sel_items[b] = true;
                if import_set.contains(&(b as u32)) {
                    if !*file_level {
                        res.notes.push(format!("{old}: {what} is in code that runs at import time → every test file loading it"));
                    }
                    *file_level = true;
                }
            }
        };
        for &l in &ch.changed {
            let c: Vec<(usize, (u32, u32))> =
                blocks.iter().filter(|&&b| span(b).0 <= l && l <= span(b).1).map(|&b| (b, span(b))).collect();
            let local = c.iter().any(|(_, s)| s.0 < l && l < s.1);
            pick(c, local, format!("line {l}"), &mut file_level);
        }
        for &p in &ch.inserted_after {
            let c: Vec<(usize, (u32, u32))> =
                blocks.iter().filter(|&&b| span(b).0 <= p && span(b).1 > p).map(|&b| (b, span(b))).collect();
            let local = !c.is_empty();
            pick(c, local, format!("insertion after line {p}"), &mut file_level);
        }
        if file_level || o.importers {
            loaders_of.push(fi);
        }
    }
    let any_change = !split.is_empty();
    let fl_by_key: BTreeMap<&str, usize> = model.fileloads.iter().enumerate().map(|(i, f)| (f.test_file.as_str(), i)).collect();
    if !loaders_of.is_empty() {
        if model.fileloads.is_empty() {
            res.run_all.push(
                "change in top-level / import-time code, but the raw data has no fileload records (module dependencies unknown)".into(),
            );
        } else {
            for fl in &model.fileloads {
                if loaders_of.iter().any(|&f| fl.modules.binary_search(&(f as u32)).is_ok()) {
                    whole.insert(fl.test_file.clone(), disp(&fl.test_file));
                }
            }
            // D5.6: a test file with any hit in the module loads it too (modules imported lazily
            // after the collector froze `fileload.modules`, C-B3 analyzer side)
            let lf: HashSet<u32> = loaders_of.iter().map(|&f| f as u32).collect();
            for u in &model.units {
                if u.items.iter().any(|&i| lf.contains(&model.items[i as usize].file)) {
                    whole.insert(u.file_key().to_string(), disp(u.file_key()));
                }
            }
        }
    }
    // ---- test files whose recorded coverage cannot be trusted (D5.7, C-M3 / C-M5) ----
    // hard: a test failed at collection, the file errored, or it has no fileload / no test
    //       record at all → selected always (even for an empty diff: it was red or unknown)
    // soft: skipped / tainted / leaky tests → the whole file whenever anything it loads changed
    let mut hard: BTreeMap<String, &'static str> = BTreeMap::new();
    let mut soft: HashSet<&str> = HashSet::new();
    for u in &model.units {
        if u.failed {
            hard.entry(u.file_key().to_string()).or_insert("a test failed when the map was recorded");
        } else if u.skipped || u.tainted || u.leaky {
            soft.insert(u.file_key());
        }
    }
    for fl in &model.fileloads {
        if fl.error {
            hard.entry(fl.test_file.clone()).or_insert("the test file failed to load when the map was recorded");
        }
    }
    if !model.fileloads.is_empty() {
        for k in test_display.keys() {
            if !fl_by_key.contains_key(k.as_str()) {
                hard.entry(k.clone()).or_insert("no fileload record (dependencies unknown)");
            } else if !with_units.contains(k) {
                hard.entry(k.clone()).or_insert("collected without any test record");
            }
        }
    } else {
        for k in test_display.keys().filter(|k| !with_units.contains(*k)) {
            hard.entry(k.clone()).or_insert("collected without any test record");
        }
    }
    if !hard.is_empty() {
        let mut by_reason: BTreeMap<&str, usize> = BTreeMap::new();
        for r in hard.values() {
            *by_reason.entry(r).or_default() += 1;
        }
        for (r, n) in by_reason {
            res.notes.push(format!("{n} test file(s) always selected: {r}"));
        }
        for k in hard.keys() {
            whole.insert(k.clone(), disp(k));
        }
    }
    if !soft.is_empty() && !changed_modules.is_empty() {
        let cm: HashSet<u32> = changed_modules.iter().map(|&f| f as u32).collect();
        let mut n = 0;
        let mut soft_hit: HashSet<&str> = HashSet::new();
        for u in &model.units {
            if soft.contains(u.file_key()) && u.items.iter().any(|&i| cm.contains(&model.items[i as usize].file)) {
                soft_hit.insert(u.file_key());
            }
        }
        for k in &soft {
            let loads = fl_by_key.get(k).is_some_and(|&i| model.fileloads[i].modules.iter().any(|m| cm.contains(m)));
            if (loads || soft_hit.contains(k)) && whole.insert(k.to_string(), disp(k)).is_none() {
                n += 1;
            }
        }
        if n > 0 {
            res.notes.push(format!("{n} test file(s) with skipped / tainted / leaky tests load a changed module → whole file selected"));
        }
    }
    // fs readers with unknown inputs: selected for every change, ignored paths included (an
    // unrecorded read can hit any file)
    if any_change && !o.fs_readers.is_empty() {
        for k in &o.fs_readers {
            whole.insert(k.clone(), disp(k));
        }
        res.notes.push(format!(
            "{} test file(s) with unrecorded file-system inputs (node:fs without complete reads, child processes, workers) → selected for every change",
            o.fs_readers.len()
        ));
    }
    for k in &deleted_tests {
        whole.remove(k);
    }
    let mut sel: Vec<bool> =
        (0..model.units.len()).map(|u| whole.contains_key(model.units[u].file_key()) || model.units[u].items.iter().any(|&i| sel_items[i as usize])).collect();
    for u in 0..model.units.len() {
        if deleted_tests.contains(model.units[u].file_key()) {
            sel[u] = false;
        }
    }
    // partially selected files (block hits only)
    let mut partial: BTreeMap<String, String> = BTreeMap::new();
    for u in 0..model.units.len() {
        let k = model.units[u].file_key();
        if sel[u] && !whole.contains_key(k) {
            partial.insert(k.to_string(), disp(k));
        }
    }
    if !o.test_granularity {
        // default: whole test files (coverage of one test can depend on earlier tests of the same
        // file – module-level caches/memoisation, VALIDATION A2; and tests the map does not know –
        // added, skipped at collection – live in those files too, C-B1 / C-M5)
        for u in 0..model.units.len() {
            if partial.contains_key(model.units[u].file_key()) {
                sel[u] = true;
            }
        }
        whole.append(&mut partial);
    }
    res.units = (0..model.units.len()).filter(|&u| sel[u]).collect();
    let mut files: Vec<SelFile> = Vec::new();
    for (k, p) in &whole {
        files.push(SelFile { path: p.clone(), whole: true, known: with_units.contains(k) });
    }
    for (_, p) in &partial {
        files.push(SelFile { path: p.clone(), whole: false, known: true });
    }
    for (k, p) in &new_tests {
        if !whole.contains_key(k) {
            files.push(SelFile { path: p.clone(), whole: true, known: false });
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files.dedup_by(|a, b| a.path == b.path);
    res.files = files;
    res
}

/// `--vitest` filters of a selection (contracts/DECISIONS.md D5.1): one `./file` per selected
/// test file; `./file:line` only for files selected partially (`--test-granularity`), never for a
/// file that changed or must run as a whole. Sorted, deduplicated.
pub fn vitest_filters(model: &Model, a: &Affected) -> Vec<String> {
    let pre = |f: &str| if paths::is_abs(f) || f.starts_with("../") { f.to_string() } else { format!("./{f}") };
    let mut out: Vec<String> = Vec::new();
    for f in &a.files {
        if f.whole {
            out.push(pre(&f.path));
            continue;
        }
        let key = paths::fold_key(&f.path, model.windows);
        let mut any_line = true;
        let mut lines = Vec::new();
        for &u in &a.units {
            let un = &model.units[u];
            if un.file_key() == key {
                match un.line {
                    Some(l) => lines.push(format!("{}:{l}", pre(&f.path))),
                    None => any_line = false,
                }
            }
        }
        if any_line && !lines.is_empty() {
            out.extend(lines);
        } else {
            out.push(pre(&f.path));
        }
    }
    out.sort();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{FileLoad, Item, Unit};

    const DIFF: &str = "diff --git a/src/price.ts b/src/price.ts
index 1..2 100644
--- a/src/price.ts
+++ b/src/price.ts
@@ -4,3 +4,4 @@ export function price(
   if (qty >= 10) total *= 0.9;
-  if (vip) total *= 0.8;
+  if (vip) total *= 0.7;
+  // note
   return Math.round(total * 100) / 100;
@@ -9,0 +11,1 @@
+  console.log(n);
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1 @@
+export const x = 1;
";

    #[test]
    fn parse() {
        let d = parse_diff(DIFF);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].old.as_deref(), Some("src/price.ts"));
        assert_eq!(d[0].changed, vec![5]);
        assert_eq!(d[0].inserted_after, vec![9]); // the "+ // note" follows a "-" → replacement
        assert_eq!(d[1].old, None);
        assert_eq!(d[1].new.as_deref(), Some("src/new.ts"));
    }

    #[test]
    fn pure_insertion_inside_hunk() {
        let d = parse_diff("--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,3 @@\n a\n+b\n c\n");
        assert_eq!(d[0].changed, Vec::<u32>::new());
        assert_eq!(d[0].inserted_after, vec![1]);
    }

    #[test]
    fn quoted_paths() {
        assert_eq!(unquote("\"src/Ulo\\305\\276it.tsx\""), "src/Uložit.tsx");
        assert_eq!(unquote("\"a\\\"b.ts\""), "a\"b.ts");
        let d = parse_diff("--- \"a/src/Ulo\\305\\276it.tsx\"\n+++ \"b/src/Ulo\\305\\276it.tsx\"\n@@ -1 +1 @@\n-x\n+y\n");
        assert_eq!(d[0].old.as_deref(), Some("src/Uložit.tsx"));
    }

    #[test]
    fn globs() {
        assert!(glob_match("*.md", "docs/a/README.md"));
        assert!(glob_match("docs/**", "docs/a/b.ts"));
        assert!(!glob_match("docs/**", "src/docs.ts"));
        assert!(glob_match("vitest.config.*", "vitest.config.ts"));
        assert!(glob_match("tsconfig*.json", "packages/a/tsconfig.app.json"));
        assert!(glob_match(".env*", ".env.local"));
        assert!(glob_match("src/**/*.{ts,tsx}", "src/a/b/c.tsx"));
        assert!(glob_match("src/**/*.ts", "src/c.ts"));
        assert!(!glob_match("*.md", "src/a.ts"));
    }

    /// test-level selection (the pre-A2 behaviour) for the block-mapping tests
    fn tg() -> AffectedOpts {
        AffectedOpts { test_granularity: true, ..Default::default() }
    }

    #[test]
    fn vitest_guard_state_is_ignored_except_incompatible() {
        let o = AffectedOpts::default();
        assert!(is_ignored(&o.ignore, ".vitest-guard/durations.json"));
        assert!(is_ignored(&o.ignore, ".vitest-guard/run/x.json"));
        assert!(!is_ignored(&o.ignore, ".vitest-guard/incompatible.json"));
        assert!(!is_ignored(&o.ignore, ".vitest-guard/conflicts.json"));
        let m = model();
        let d = parse_diff("--- a/.vitest-guard/durations.json\n+++ b/.vitest-guard/durations.json\n@@ -1 +1 @@\n-a\n+b\n--- a/.vitest-guard/incompatible.json\n+++ b/.vitest-guard/incompatible.json\n@@ -1 +1 @@\n-a\n+b\n");
        let a = affected(&m, &d, &o);
        assert_eq!(a.ignored, vec![".vitest-guard/durations.json"]);
        assert_eq!(a.run_all.len(), 1);
    }

    #[test]
    fn fs_reads_select_readers() {
        let mut m = model();
        m.files.push("src/ui/tokens.css".into());
        m.fileloads = vec![
            FileLoad { test_file: "test/p.test.ts".into(), modules: vec![0], reads: Some(vec![]), ..Default::default() },
            FileLoad { test_file: "test/r.test.ts".into(), modules: vec![], reads: Some(vec!["src/ui".into()]), ..Default::default() },
        ];
        // CSS file unknown to the module graph but read by r.test.ts → no run-all, readers selected
        let d = parse_diff("--- a/src/ui/tokens.css\n+++ b/src/ui/tokens.css\n@@ -1 +1 @@\n-a\n+b\n");
        let a = affected(&m, &d, &AffectedOpts::default());
        assert!(a.run_all.is_empty(), "{:?}", a.run_all);
        assert_eq!(a.units, vec![3]);
        // a file not read by anybody and unknown → run all
        let d = parse_diff("--- a/src/other.css\n+++ b/src/other.css\n@@ -1 +1 @@\n-a\n+b\n");
        assert_eq!(affected(&m, &d, &AffectedOpts::default()).run_all.len(), 1);
        // fallback: fs users without recorded reads are selected for every change
        let d = parse_diff(DIFF.split("diff --git a/src/new.ts").next().unwrap());
        let o = AffectedOpts { fs_readers: vec!["test/r.test.ts".into()], ..Default::default() };
        let a = affected(&m, &d, &o);
        assert!(a.units.contains(&3));
    }

    fn model() -> Model {
        // blocks: 0 = function body 1-7, 1 = vip branch 5-5, 2 = format body 8-10
        let items = vec![
            Item { file: 0, lines: vec![1], span: (1, 7) },
            Item { file: 0, lines: vec![5], span: (5, 5) },
            Item { file: 0, lines: vec![8], span: (8, 10) },
        ];
        let unit = |id: &str, tf: &str, items: Vec<u32>| Unit {
            id: id.into(),
            items,
            key: (tf.into(), 1, id.into()),
            ..Default::default()
        };
        Model {
            files: vec!["src/price.ts".into(), "src/data.json".into()],
            items,
            units: vec![
                unit("basic", "test/p.test.ts", vec![0]),
                unit("vip", "test/p.test.ts", vec![0, 1]),
                unit("format", "test/p.test.ts", vec![2]),
                unit("rate", "test/r.test.ts", vec![]),
            ],
            ..Default::default()
        }
    }

    #[test]
    fn mapping() {
        let m = model();
        let a = affected(&m, &parse_diff(DIFF), &tg());
        // broad: line 5 → function body + branch → basic, vip; insertion after 9 → format
        assert_eq!(a.units, vec![0, 1, 2]);
        assert_eq!(a.run_all.len(), 1); // src/new.ts
        let a = affected(&m, &parse_diff(DIFF), &AffectedOpts { innermost: true, ..tg() });
        assert_eq!(a.units, vec![1, 2]);
        // default: whole test files (all three tests live in test/p.test.ts)
        let a = affected(&m, &parse_diff(DIFF), &AffectedOpts { innermost: true, ..Default::default() });
        assert_eq!(a.units, vec![0, 1, 2]);
    }

    #[test]
    fn top_level_uses_fileloads() {
        let mut m = model();
        let d = parse_diff("--- a/src/price.ts\n+++ b/src/price.ts\n@@ -12 +12 @@\n-export const RATE = 1;\n+export const RATE = 2;\n");
        // no fileload data → run all
        let a = affected(&m, &d, &tg());
        assert_eq!(a.run_all.len(), 1);
        m.fileloads = vec![
            FileLoad { test_file: "test/r.test.ts".into(), modules: vec![0], ..Default::default() },
            FileLoad { test_file: "test/other.test.ts".into(), modules: vec![1], ..Default::default() },
            FileLoad { test_file: "test/p.test.ts".into(), modules: vec![], ..Default::default() },
        ];
        let a = affected(&m, &d, &tg());
        assert!(a.run_all.is_empty());
        // r.test.ts lists the module; p.test.ts does not, but its tests HIT the module, so it
        // loads it too (D5.6: lazily imported modules are missing from `fileload.modules`)
        assert_eq!(a.units, vec![0, 1, 2, 3]);
        // without those hits only the listed loader is selected
        let mut m2 = model();
        m2.fileloads = m.fileloads.clone();
        for u in &mut m2.units {
            u.items.clear();
        }
        assert_eq!(affected(&m2, &d, &tg()).units, vec![3]);
        // import-time block → importers too
        m.import_items = vec![2];
        let d = parse_diff("--- a/src/price.ts\n+++ b/src/price.ts\n@@ -9 +9 @@\n-a\n+b\n");
        let a = affected(&m, &d, &tg());
        assert_eq!(a.units, vec![0, 1, 2, 3]);
        // module known only from fileload (json) → its importers
        let d = parse_diff("--- a/src/data.json\n+++ b/src/data.json\n@@ -1 +1 @@\n-1\n+2\n");
        let a = affected(&m, &d, &tg());
        assert!(a.units.is_empty() && a.run_all.is_empty());
    }

    #[test]
    fn ignore_and_run_all() {
        let m = model();
        let d = parse_diff("--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-a\n+b\n");
        let a = affected(&m, &d, &AffectedOpts::default());
        assert_eq!(a.ignored, vec!["README.md"]);
        assert_eq!(a.run_all.len(), 1);
        let d = parse_diff("--- a/test/__snapshots__/p.test.ts.snap\n+++ b/test/__snapshots__/p.test.ts.snap\n@@ -1 +1 @@\n-a\n+b\n");
        let a = affected(&m, &d, &AffectedOpts::default());
        assert_eq!(a.units, vec![0, 1, 2]);
    }
}
