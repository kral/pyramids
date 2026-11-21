//! Reading raw `w-*.jsonl` files (parallel) and building the [`Model`] (v2 primary, v1 fallback).

use crate::flatten::{flatten_functions, Flat};
use crate::model::{FileLoad, FileTable, Item, Model, TestMeta, UnitBuilder};
use crate::paths;
use crate::v1::{self, V1Test};
use rayon::prelude::*;
use rustc_hash::FxHashMap;
use serde::de::IgnoredAny;
use serde::Deserialize;
use std::path::Path;

#[derive(Deserialize)]
struct CovRaw {
    url: String,
    #[serde(default)]
    functions: Vec<Vec<(u32, u32, u64)>>,
}

#[derive(Deserialize)]
struct Rec {
    t: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    line: Option<u32>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default, rename = "durationMs")]
    duration_ms: Option<f64>,
    #[serde(default)]
    assertions: Option<u64>,
    #[serde(default)]
    cov: Option<Vec<CovRaw>>,
    #[serde(default)]
    hits: Option<FxHashMap<String, Vec<u32>>>,
    #[serde(default)]
    blocks: Option<Vec<(u32, u32, u32, u32, IgnoredAny)>>,
    #[serde(default, rename = "gitHead")]
    git_head: Option<String>,
    #[serde(default)]
    version: Option<u32>,
    #[serde(default)]
    root: Option<String>,
    #[serde(default)]
    reads: Option<Vec<ReadEntry>>,
    #[serde(default)]
    dirty: Option<bool>,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default, rename = "setupFiles")]
    setup_files: Option<Vec<String>>,
    #[serde(default, rename = "testFile")]
    test_file: Option<String>,
    #[serde(default)]
    modules: Option<Vec<ModEntry>>,
    #[serde(default, rename = "loadMs")]
    load_ms: Option<FxHashMap<String, f64>>,
    #[serde(default)]
    tainted: Option<bool>,
    #[serde(default)]
    leaky: Option<bool>,
    #[serde(default, rename = "retryCount")]
    retry_count: Option<u32>,
    #[serde(default, rename = "assertHash")]
    assert_hash: Option<String>,
    #[serde(default, rename = "domHash")]
    dom_hash: Option<String>,
    #[serde(default, rename = "readsComplete")]
    reads_complete: Option<bool>,
    #[serde(default)]
    error: Option<serde_json::Value>,
    #[serde(default, rename = "dirtyFiles")]
    dirty_files: Option<Vec<DirtyEntry>>,
    #[serde(default, rename = "testFiles")]
    test_files: Option<Vec<String>>,
}

/// `meta.dirtyFiles` entry: a path, or `{"path": p, "sha256": contentHash | null}`.
#[derive(Deserialize)]
#[serde(untagged)]
enum DirtyEntry {
    Path(String),
    Obj {
        path: String,
        #[serde(default)]
        sha256: Option<String>,
    },
}

/// `fileload.reads` entry: a path (file or directory read through node:fs), or `{"path": p, ...}`.
#[derive(Deserialize)]
#[serde(untagged)]
enum ReadEntry {
    Path(String),
    Obj {
        #[serde(alias = "file")]
        path: String,
    },
}

/// `modules` entry: a path, or `{"file": path, "loadMs": 1.2}`.
#[derive(Deserialize)]
#[serde(untagged)]
enum ModEntry {
    Path(String),
    Obj {
        file: String,
        #[serde(default, rename = "loadMs")]
        load_ms: Option<f64>,
    },
}

pub struct RawFileLoad {
    pub test_file: String,
    /// paths read through node:fs (None = the collector did not record reads)
    pub reads: Option<Vec<String>>,
    pub hits: Vec<(String, Vec<u32>)>,
    /// (module path, optional load time in ms)
    pub modules: Vec<(String, Option<f64>)>,
    pub reads_complete: Option<bool>,
    /// the test file failed to load / a file-level hook threw
    pub error: bool,
}

struct RawMeta {
    root: Option<String>,
    git_head: Option<String>,
    setup_files: Vec<String>,
    version: Option<u32>,
    dirty: bool,
    dirty_files: Option<Vec<(String, Option<String>)>>,
    test_files: Vec<String>,
}

enum Parsed {
    Script(String, String),
    File(String, Vec<(u32, u32)>, Option<String>),
    V1(V1Test),
    V2(TestMeta, Vec<(String, Vec<u32>)>),
    Meta(RawMeta),
    FileLoad(RawFileLoad),
    Skip,
}

fn parse_line(line: &str) -> Result<Parsed, String> {
    let r: Rec = serde_json::from_str(line).map_err(|e| e.to_string())?;
    Ok(match r.t.as_str() {
        "script" => Parsed::Script(r.url.ok_or("script without url")?, r.source.unwrap_or_default()),
        "file" => Parsed::File(
            r.file.ok_or("file record without file")?,
            r.blocks.unwrap_or_default().into_iter().map(|b| (b.0, b.2)).collect(),
            r.sha256,
        ),
        "meta" => Parsed::Meta(RawMeta {
            root: r.root,
            git_head: r.git_head,
            setup_files: r.setup_files.unwrap_or_default(),
            version: r.version,
            dirty: r.dirty.unwrap_or(false),
            dirty_files: r.dirty_files.map(|v| {
                v.into_iter()
                    .map(|e| match e {
                        DirtyEntry::Path(p) => (p, None),
                        DirtyEntry::Obj { path, sha256 } => (path, sha256.map(|h| h.to_ascii_lowercase())),
                    })
                    .collect()
            }),
            test_files: r.test_files.unwrap_or_default(),
        }),
        "fileload" => Parsed::FileLoad(RawFileLoad {
            test_file: r.test_file.or(r.file).ok_or("fileload without testFile")?,
            reads: r.reads.map(|v| {
                v.into_iter()
                    .map(|e| match e {
                        ReadEntry::Path(p) => p,
                        ReadEntry::Obj { path } => path,
                    })
                    .collect()
            }),
            hits: r.hits.map(|h| h.into_iter().collect()).unwrap_or_default(),
            reads_complete: r.reads_complete,
            error: r.error.is_some_and(|e| !matches!(e, serde_json::Value::Null | serde_json::Value::Bool(false))),
            modules: {
                let lm = r.load_ms.unwrap_or_default();
                r.modules
                    .unwrap_or_default()
                    .into_iter()
                    .map(|m| match m {
                        ModEntry::Path(p) => {
                            let ms = lm.get(&p).copied();
                            (p, ms)
                        }
                        ModEntry::Obj { file, load_ms } => {
                            let ms = load_ms.or_else(|| lm.get(&file).copied());
                            (file, ms)
                        }
                    })
                    .collect()
            },
        }),
        "test" => {
            let meta = TestMeta {
                file: r.file.unwrap_or_default(),
                name: r.name.unwrap_or_default(),
                line: r.line,
                failed: r.state.as_deref() == Some("fail"),
                skipped: matches!(r.state.as_deref(), Some("skip") | Some("todo")),
                tainted: r.tainted.unwrap_or(false),
                leaky: r.leaky.unwrap_or(false),
                retried: r.retry_count.unwrap_or(0) > 0,
                duration_ms: r.duration_ms,
                assertions: r.assertions,
                assert_hash: r.assert_hash,
                dom_hash: r.dom_hash,
            };
            if let Some(h) = r.hits {
                let mut v: Vec<(String, Vec<u32>)> = h.into_iter().collect();
                v.sort_by(|a, b| a.0.cmp(&b.0));
                Parsed::V2(meta, v)
            } else {
                let cov = r
                    .cov
                    .unwrap_or_default()
                    .into_iter()
                    .map(|c| (c.url, flatten_functions(&c.functions)))
                    .filter(|(_, f): &(String, Flat)| !f.covered.is_empty() || !f.skipped.is_empty())
                    .collect();
                Parsed::V1(V1Test { meta, cov })
            }
        }
        _ => Parsed::Skip,
    })
}

/// All `w-*.jsonl` / `s-*.jsonl` files below `dir` (recursively – one sub-directory per CI shard is
/// fine). A single file argument (stored map) is read regardless of its name.
/// Symbolic links (files and directories) are never followed (SECURITY-REVIEW F19).
pub fn list_raw_files(dir: &Path) -> std::io::Result<Vec<std::path::PathBuf>> {
    if std::fs::symlink_metadata(dir)?.is_file() {
        return Ok(vec![dir.to_path_buf()]); // a single stored map / raw file
    }
    fn walk(d: &Path, out: &mut Vec<std::path::PathBuf>, top: bool) -> std::io::Result<()> {
        let rd = match std::fs::read_dir(d) {
            Ok(r) => r,
            Err(e) if !top => {
                eprintln!("vto: warning: {}: {e}", d.display());
                return Ok(());
            }
            Err(e) => return Err(e),
        };
        for e in rd.flatten() {
            let p = e.path();
            let ft = e.file_type()?; // does not follow symlinks
            if ft.is_symlink() {
                eprintln!("vto: warning: {}: symbolic link skipped", crate::sanitize::term(&p.to_string_lossy()));
                continue;
            }
            if ft.is_dir() {
                walk(&p, out, false)?;
            } else if p.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                (n.starts_with("w-") || n.starts_with("s-")) && n.ends_with(".jsonl")
            }) {
                // only vto's own files (a raw dir also holds `.gitignore`, `.vto-raw`, …)
                out.push(p);
            }
        }
        Ok(())
    }
    let mut v = Vec::new();
    walk(dir, &mut v, true)?;
    v.sort();
    Ok(v)
}

/// Input bounds (SECURITY-REVIEW F15). Exceeding any of them is an error, never a silent cut.
#[derive(Debug, Clone)]
pub struct Limits {
    pub max_raw_bytes: u64,
    pub max_line_bytes: usize,
    pub max_records: usize,
    pub max_blocks_per_file: usize,
    pub max_line_no: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_raw_bytes: 2 << 30,
            max_line_bytes: 16 << 20,
            max_records: 20_000_000,
            max_blocks_per_file: 1_000_000,
            max_line_no: 10_000_000,
        }
    }
}

/// Highest raw format version this analyzer understands (`meta.version`).
pub const RAW_VERSION: u32 = 2;

/// Reads the raw dir and builds the model. `root` = normalised absolute root for relative paths.
pub fn load(dir: &Path, root: &str) -> Result<Model, String> {
    load_with(dir, root, &Limits::default())
}

pub fn load_with(dir: &Path, root: &str, lim: &Limits) -> Result<Model, String> {
    load_full(dir, root, lim, paths::is_windows_path(root))
}

/// `fold` = compare paths case-insensitively (probed for the root's file system by the caller,
/// contracts/DECISIONS.md D2.4; always on for drive-letter paths).
pub fn load_full(dir: &Path, root: &str, lim: &Limits, fold: bool) -> Result<Model, String> {
    let shown = crate::sanitize::term(&dir.to_string_lossy());
    let files = list_raw_files(dir).map_err(|e| format!("{shown}: {e}"))?;
    if files.is_empty() {
        return Err(format!("{shown}: no w-*.jsonl / s-*.jsonl files"));
    }
    let mut total = 0u64;
    for p in &files {
        total += std::fs::symlink_metadata(p).map(|m| m.len()).unwrap_or(0);
    }
    if total > lim.max_raw_bytes {
        return Err(format!("raw data is {total} bytes, above the limit of {} (--max-raw-bytes)", lim.max_raw_bytes));
    }
    let contents: Vec<(String, String)> = files
        .par_iter()
        .map(|p| {
            let s = std::fs::read(p).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
            (p.strip_prefix(dir).unwrap_or(p).to_string_lossy().into_owned(), s)
        })
        .collect();
    let lines: Vec<(usize, usize, &str)> = contents
        .iter()
        .enumerate()
        .flat_map(|(fi, (_, c))| c.lines().enumerate().filter(|(_, l)| !l.trim().is_empty()).map(move |(li, l)| (fi, li, l)))
        .collect();
    if lines.len() > lim.max_records {
        return Err(format!("{} raw records, above the limit of {} (--max-records)", lines.len(), lim.max_records));
    }
    if let Some(&(fi, li, l)) = lines.iter().find(|x| x.2.len() > lim.max_line_bytes) {
        return Err(format!(
            "{}:{}: record of {} bytes, above the limit of {} (--max-line-bytes)",
            crate::sanitize::term(&contents[fi].0),
            li + 1,
            l.len(),
            lim.max_line_bytes
        ));
    }
    let parsed: Vec<(usize, usize, Result<Parsed, String>)> =
        lines.par_iter().with_min_len(16).map(|&(fi, li, l)| (fi, li, parse_line(l))).collect();
    drop(lines);

    let mut warnings = Vec::new();
    let mut scripts = Vec::new();
    let mut fileblocks: Vec<(String, Vec<(u32, u32)>, Option<String>)> = Vec::new();
    let mut integrity: Vec<String> = Vec::new();
    let mut versions: Vec<u32> = Vec::new();
    let mut meta_seen = false;
    let mut dirty = false;
    let mut dirty_files: Option<Vec<(String, Option<String>)>> = None;
    let mut dirty_metas = 0usize;
    let mut meta_test_files: Vec<String> = Vec::new();
    let mut v1t = Vec::new();
    let mut v2t = Vec::new();
    let mut git_head = None;
    let mut meta_root: Option<String> = None;
    let mut setup_files: Vec<String> = Vec::new();
    let mut fileloads: Vec<RawFileLoad> = Vec::new();
    let mut bad = 0;
    for (fi, li, r) in parsed {
        match r {
            Ok(Parsed::Script(u, s)) => scripts.push((u, s)),
            Ok(Parsed::File(f, b, h)) => {
                if b.len() > lim.max_blocks_per_file {
                    return Err(format!("{}: {} blocks, above the limit of {}", crate::sanitize::term(&f), b.len(), lim.max_blocks_per_file));
                }
                if b.iter().any(|&(s, e)| s == 0 || e < s || e > lim.max_line_no) {
                    integrity.push(format!("{}: block table with invalid line ranges", crate::sanitize::term(&f)));
                }
                fileblocks.push((f, b, h))
            }
            Ok(Parsed::V1(t)) => v1t.push(t),
            Ok(Parsed::V2(m, h)) => v2t.push((m, h)),
            Ok(Parsed::FileLoad(f)) => fileloads.push(f),
            Ok(Parsed::Meta(m)) => {
                meta_seen = true;
                if let Some(r) = &m.root {
                    let r = paths::normalize(r);
                    if meta_root.as_ref().is_some_and(|x| paths::fold_key(x, paths::is_windows_path(x)) != paths::fold_key(&r, paths::is_windows_path(&r))) {
                        integrity.push(format!("raw data mixes several roots ({} vs {})", crate::sanitize::term(meta_root.as_ref().unwrap()), crate::sanitize::term(&r)));
                    }
                    meta_root.get_or_insert(r);
                }
                dirty |= m.dirty;
                if m.dirty {
                    dirty_metas += 1;
                }
                if let Some(d) = m.dirty_files {
                    dirty_files.get_or_insert_with(Vec::new).extend(d);
                    dirty_metas = dirty_metas.saturating_sub(1);
                }
                meta_test_files.extend(m.test_files);
                if let Some(v) = m.version {
                    versions.push(v);
                }
                let g = m.git_head;
                for f in m.setup_files {
                    if !setup_files.contains(&f) {
                        setup_files.push(f);
                    }
                }
                if let Some(g) = g {
                    if git_head.as_ref().is_some_and(|x: &String| *x != g) {
                        let msg = format!("raw data mixes several gitHead values ({} vs {g})", git_head.as_ref().unwrap());
                        warnings.push(msg.clone());
                        integrity.push(msg);
                    }
                    git_head.get_or_insert(g);
                }
            }
            Ok(Parsed::Skip) => {}
            Err(e) => {
                bad += 1;
                if bad <= 5 {
                    warnings.push(format!("{}:{}: invalid record: {e}", contents[fi].0, li + 1));
                }
            }
        }
    }
    if bad > 5 {
        warnings.push(format!("{bad} invalid records in total"));
    }
    if bad > 0 {
        integrity.push(format!("{bad} invalid raw records"));
    }
    if let Some(&v) = versions.iter().max() {
        if v > RAW_VERSION {
            return Err(format!("raw format version {v} is newer than supported ({RAW_VERSION}) – update vto"));
        }
    }
    // several dirty meta records, but not all of them list their files → the list is incomplete
    if dirty_metas > 0 {
        dirty_files = None;
    }
    // format 2.1: paths are relative to the recorded root. Stored and raw maps are portable
    // (contracts/DECISIONS.md D2.6): relative paths – and absolute paths below `meta.root` – are
    // re-based onto the READER's root; only files outside the recorded root stay absolute.
    let wfold = |p: &str| paths::fold_key(p, fold || paths::is_windows_path(p));
    let rebase = |p: &mut String| {
        if p.contains("://") {
            return;
        }
        if !paths::is_abs(p) {
            if meta_root.is_some() {
                *p = paths::join(root, p);
            }
            return;
        }
        if let Some(mr) = &meta_root {
            let n = paths::normalize(p);
            let (kn, km) = (wfold(&n), wfold(mr));
            if kn == km {
                *p = root.to_string();
            } else if kn.starts_with(&format!("{}/", km.trim_end_matches('/'))) {
                *p = paths::join(root, &paths::rel(&n, mr));
            }
        }
    };
    {
        for f in &mut fileblocks {
            rebase(&mut f.0);
        }
        for (m, hits) in &mut v2t {
            rebase(&mut m.file);
            for h in hits.iter_mut() {
                rebase(&mut h.0);
            }
        }
        for fl in &mut fileloads {
            rebase(&mut fl.test_file);
            for m in &mut fl.modules {
                rebase(&mut m.0);
            }
            for h in &mut fl.hits {
                rebase(&mut h.0);
            }
            if let Some(rd) = &mut fl.reads {
                for r in rd.iter_mut() {
                    rebase(r);
                }
            }
        }
        for t in &mut v1t {
            rebase(&mut t.meta.file);
        }
    }
    let to_display = |f: &str| -> String {
        let mut a = f.to_string();
        if !paths::is_abs(&a) {
            a = paths::join(root, &a); // meta paths are root-relative even without meta.root
        } else {
            rebase(&mut a);
        }
        paths::rel(&paths::normalize(&a), root)
    };
    let setup_files: Vec<String> = setup_files.iter().map(|f| to_display(f)).collect();
    let dirty_files: Option<Vec<(String, Option<String>)>> =
        dirty_files.map(|v| v.into_iter().map(|(p, h)| (to_display(&p), h)).collect());
    let mut meta_test_files: Vec<String> = meta_test_files.iter().map(|f| to_display(f)).collect();
    meta_test_files.sort();
    meta_test_files.dedup();
    let mut model = if !v2t.is_empty() || !fileblocks.is_empty() {
        if !v1t.is_empty() {
            warnings.push(format!("mixed v1 and v2 records – {} v1 (V8) test records ignored", v1t.len()));
        }
        build_v2(fileblocks, v2t, fileloads, root, fold, &mut warnings, &mut integrity)
    } else {
        if !fileloads.is_empty() {
            warnings.push("fileload records are only supported with v2 data – ignored".into());
        }
        v1::build(scripts, v1t, root, &mut warnings)
    };
    model.git_head = git_head;
    model.setup_files = setup_files;
    model.format_version = versions.iter().max().copied();
    model.meta_seen = meta_seen;
    model.dirty = dirty;
    model.integrity.extend(integrity);
    model.windows = fold || paths::is_windows_path(root);
    model.meta_root = meta_root;
    model.dirty_files = dirty_files;
    model.test_files = meta_test_files;
    warnings.append(&mut model.warnings);
    model.warnings = warnings;
    Ok(model)
}

fn build_v2(
    fileblocks: Vec<(String, Vec<(u32, u32)>, Option<String>)>,
    tests: Vec<(TestMeta, Vec<(String, Vec<u32>)>)>,
    raw_fileloads: Vec<RawFileLoad>,
    root: &str,
    fold: bool,
    warnings: &mut Vec<String>,
    integrity: &mut Vec<String>,
) -> Model {
    let mut hashes: FxHashMap<u32, String> = FxHashMap::default();
    let win = fold || paths::is_windows_path(root);
    let key = |f: &str| paths::fold_key(&paths::normalize(f), win);
    let mut ft = FileTable::new(win);
    // per raw path: (offset, blocks)
    let mut map: FxHashMap<String, (u32, usize)> = FxHashMap::default();
    let mut items: Vec<Item> = Vec::new();
    for (raw_f, blocks, hash) in fileblocks {
        let f = key(&raw_f);
        if let Some(&(_, n)) = map.get(&f) {
            if n != blocks.len() {
                let msg = format!("{}: block lists differ between workers ({n} vs {})", crate::sanitize::term(&raw_f), blocks.len());
                warnings.push(format!("{msg}, using the first"));
                integrity.push(msg);
            }
            continue;
        }
        let fid = ft.intern(&paths::rel(&paths::normalize(&raw_f), root));
        if let Some(h) = hash {
            hashes.insert(fid, h.to_ascii_lowercase());
        }
        map.insert(f, (items.len() as u32, blocks.len()));
        items.extend(blocks.into_iter().map(|(s, e)| Item { file: fid, lines: vec![s], span: (s, e.max(s)) }));
    }
    // hits referring to unknown files / ids beyond the block list → synthetic items
    let mut extra: FxHashMap<(String, u32), u32> = FxHashMap::default();
    let mut unknown = 0usize;
    let mut ub = UnitBuilder::with_fold(root, win);
    for (meta, hits) in tests {
        let mut v = Vec::new();
        for (f, ids) in hits {
            let f = key(&f);
            let known = map.get(&f).copied();
            for id in ids {
                match known {
                    Some((off, n)) if (id as usize) < n => v.push(off + id),
                    _ => {
                        unknown += 1;
                        let key = (f.clone(), id);
                        let next = items.len() as u32;
                        let gid = *extra.entry(key).or_insert_with(|| {
                            let fid = ft.intern(&paths::rel(&paths::normalize(&f), root));
                            items.push(Item { file: fid, lines: vec![], span: (0, 0) });
                            next
                        });
                        v.push(gid);
                    }
                }
            }
        }
        ub.add(meta, v);
    }
    if unknown > 0 {
        warnings.push(format!("{unknown} hits reference files/blocks without a file record (no line info)"));
        integrity.push(format!("{unknown} hits reference files/blocks without a file record"));
    }
    // import-time data per test file
    let mut fl_map: FxHashMap<String, usize> = FxHashMap::default();
    let mut fileloads: Vec<FileLoad> = Vec::new();
    let mut import_items: Vec<u32> = Vec::new();
    for fl in raw_fileloads {
        let tk = paths::fold_key(&paths::rel(&paths::normalize(&fl.test_file), root), win);
        let display = paths::rel(&paths::normalize(&fl.test_file), root);
        let i = *fl_map.entry(tk.clone()).or_insert_with(|| {
            fileloads.push(FileLoad { test_file: tk, display, ..Default::default() });
            fileloads.len() - 1
        });
        if let Some(c) = fl.reads_complete {
            // several records (shards, retries): incomplete wins
            fileloads[i].reads_complete = Some(fileloads[i].reads_complete.unwrap_or(true) && c);
        }
        fileloads[i].error |= fl.error;
        if let Some(rd) = &fl.reads {
            let e = fileloads[i].reads.get_or_insert_with(Vec::new);
            for r in rd {
                let d = paths::rel(&paths::normalize(r), root);
                let d = d.trim_end_matches('/').to_string();
                if !e.contains(&d) {
                    e.push(d);
                }
            }
        }
        for (m, ms) in fl.modules.iter().map(|(m, ms)| (m, *ms)).chain(fl.hits.iter().map(|h| (&h.0, None))) {
            let id = ft.intern(&paths::rel(&paths::normalize(m), root));
            if paths::fold_key(&ft.names[id as usize], win) == fileloads[i].test_file {
                continue; // the test file itself
            }
            fileloads[i].modules.push(id);
            if let Some(ms) = ms {
                let e = fileloads[i].load_ms.iter_mut().find(|x| x.0 == id);
                match e {
                    Some(x) => x.1 = x.1.max(ms),
                    None => fileloads[i].load_ms.push((id, ms)),
                }
            }
        }
        for (f, ids) in fl.hits {
            if let Some(&(off, n)) = map.get(&key(&f)) {
                import_items.extend(ids.into_iter().filter(|&x| (x as usize) < n).map(|x| off + x));
            }
        }
    }
    for f in &mut fileloads {
        f.modules.sort_unstable();
        f.modules.dedup();
    }
    import_items.sort_unstable();
    import_items.dedup();
    let units = ub.finish(warnings);
    let file_hashes = (0..ft.names.len() as u32).map(|i| hashes.remove(&i)).collect();
    Model { files: ft.names, items, units, format: "v2", fileloads, import_items, file_hashes, ..Default::default() }
}
