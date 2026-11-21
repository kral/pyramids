//! Common input model produced by both raw formats (v2 block hits, v1 V8 coverage).

use crate::paths;
use rustc_hash::FxHashMap;

#[derive(Debug, Clone)]
pub struct Item {
    /// index into `Model::files`
    pub file: u32,
    /// 1-based original lines used for reporting (sorted, dedup, non-empty unless unknown)
    pub lines: Vec<u32>,
    /// 1-based inclusive line span (for `affected`)
    pub span: (u32, u32),
}

#[derive(Debug, Clone, Default)]
pub struct Unit {
    /// "relpath:line > full name"
    pub id: String,
    /// display path of the test file (relative to root)
    pub file: String,
    pub line: Option<u32>,
    pub names: Vec<String>,
    pub failed: bool,
    pub skipped: bool,
    pub tainted: bool,
    pub leaky: bool,
    pub retried: bool,
    /// number of raw records merged into this unit (>1: shards / repeats)
    pub records: u32,
    pub duration_ms: Option<f64>,
    pub assertions: Option<u64>,
    pub assert_hash: Option<String>,
    pub dom_hash: Option<String>,
    /// sorted, deduplicated item ids
    pub items: Vec<u32>,
    /// sort / identity key (folded file key, line, name)
    pub(crate) key: (String, u32, String),
}

impl Unit {
    /// Reason code why the unit is excluded from verdicts (None = clean):
    /// `failed` | `skipped` | `tainted` | `leaky` (texts in `i18n`, key `reason.<code>`).
    pub fn excluded(&self) -> Option<&'static str> {
        if self.failed {
            Some("failed")
        } else if self.skipped {
            Some("skipped")
        } else if self.tainted {
            Some("tainted")
        } else if self.leaky {
            Some("leaky")
        } else {
            None
        }
    }
    /// folded test-file key
    pub fn file_key(&self) -> &str {
        &self.key.0
    }
}

/// Import-time data of one test file (`fileload` records, unioned).
#[derive(Debug, Clone, Default)]
pub struct FileLoad {
    /// folded key of the test file (same as `Unit::file_key`)
    pub test_file: String,
    /// display path of the test file
    pub display: String,
    /// indices into `Model::files` of every module evaluated for the test file (sorted)
    pub modules: Vec<u32>,
    /// optional per-module load time (file index, ms; max over records)
    pub load_ms: Vec<(u32, f64)>,
    /// root-relative paths (files or directories) the test file read through node:fs;
    /// None = not recorded by the collector
    pub reads: Option<Vec<String>>,
    /// `fileload.readsComplete`: the collector vouches that `reads` is complete (Some(true)),
    /// knows it is not (Some(false)), or says nothing (None → source heuristics decide)
    pub reads_complete: Option<bool>,
    /// the test file failed to load / a file-level hook threw: coverage is incomplete
    pub error: bool,
}

#[derive(Debug, Default)]
pub struct Model {
    /// display paths (relative to --root, '/' separators)
    pub files: Vec<String>,
    pub items: Vec<Item>,
    pub units: Vec<Unit>,
    /// "v2" or "v1"
    pub format: &'static str,
    pub warnings: Vec<String>,
    /// gitHead from an optional {"t":"meta"} record
    pub git_head: Option<String>,
    /// setupFiles from meta records (display paths)
    pub setup_files: Vec<String>,
    /// per test file import-time info; empty = collector did not emit `fileload`
    pub fileloads: Vec<FileLoad>,
    /// items hit at import time / in beforeAll (union over all fileloads)
    pub import_items: Vec<u32>,
    /// true when paths are Windows paths (case-insensitive)
    pub windows: bool,
    /// `meta.version` (raw format version), if any meta record carried it
    pub format_version: Option<u32>,
    /// at least one meta record was present
    pub meta_seen: bool,
    /// the map was recorded on a dirty working tree (`meta.dirty`)
    pub dirty: bool,
    /// consistency problems of the raw data; `affected` refuses (run all) when non-empty
    pub integrity: Vec<String>,
    /// per file (parallel to `files`): recorded SHA-256 of the original source, lower-case hex
    pub file_hashes: Vec<Option<String>>,
    /// `meta.root` as recorded (normalised), for messages
    pub meta_root: Option<String>,
    /// `meta.dirtyFiles`: (display path, content hash at record time) of every file that was
    /// modified / untracked when the map was recorded; None = not recorded
    pub dirty_files: Option<Vec<(String, Option<String>)>>,
    /// `meta.testFiles`: every test file Vitest collected (display paths; empty = not recorded)
    pub test_files: Vec<String>,
}

impl Model {
    pub fn file_index(&self) -> FxHashMap<String, usize> {
        self.files.iter().enumerate().map(|(i, f)| (paths::fold_key(f, self.windows), i)).collect()
    }
}

/// Metadata of one raw test record.
#[derive(Debug, Clone, Default)]
pub struct TestMeta {
    pub file: String,
    pub name: String,
    pub line: Option<u32>,
    pub failed: bool,
    pub skipped: bool,
    pub tainted: bool,
    pub leaky: bool,
    pub retried: bool,
    pub duration_ms: Option<f64>,
    pub assertions: Option<u64>,
    pub assert_hash: Option<String>,
    pub dom_hash: Option<String>,
}

/// Groups raw test records into units by (file, full name, line). Several records of the same
/// unit (shards that ran the same test, repeats) are unioned.
pub struct UnitBuilder<'r> {
    root: &'r str,
    windows: bool,
    map: FxHashMap<(String, Option<u32>, String), usize>,
    pub units: Vec<Unit>,
    pub missing_line: usize,
}

impl<'r> UnitBuilder<'r> {
    pub fn new(root: &'r str) -> Self {
        Self::with_fold(root, paths::is_windows_path(root))
    }

    pub fn with_fold(root: &'r str, fold: bool) -> Self {
        Self { root, windows: fold, map: FxHashMap::default(), units: Vec::new(), missing_line: 0 }
    }

    pub fn add(&mut self, m: TestMeta, items: impl IntoIterator<Item = u32>) {
        let rel = paths::rel(&paths::normalize(&m.file), self.root);
        let fk = paths::fold_key(&rel, self.windows);
        let k = (fk.clone(), m.line, m.name.clone());
        if m.line.is_none() {
            self.missing_line += 1;
        }
        let idx = *self.map.entry(k).or_insert_with(|| {
            let id = match m.line {
                Some(l) => format!("{rel}:{l} > {}", m.name),
                None => format!("{rel} > {}", m.name),
            };
            self.units.push(Unit {
                id,
                file: rel.clone(),
                line: m.line,
                names: vec![m.name.clone()],
                key: (fk.clone(), m.line.unwrap_or(0), m.name.clone()),
                ..Default::default()
            });
            self.units.len() - 1
        });
        let u = &mut self.units[idx];
        u.records += 1;
        u.failed |= m.failed;
        u.skipped |= m.skipped;
        u.tainted |= m.tainted;
        u.leaky |= m.leaky;
        u.retried |= m.retried;
        if let Some(d) = m.duration_ms {
            u.duration_ms = Some(u.duration_ms.map_or(d, |x| x.max(d)));
        }
        if let Some(a) = m.assertions {
            u.assertions = Some(u.assertions.map_or(a, |x| x.max(a)));
        }
        if u.records > 1 && (u.assert_hash != m.assert_hash || u.dom_hash != m.dom_hash) {
            u.assert_hash = None;
            u.dom_hash = None;
        } else {
            u.assert_hash = m.assert_hash;
            u.dom_hash = m.dom_hash;
        }
        u.items.extend(items);
    }

    pub fn finish(mut self, warnings: &mut Vec<String>) -> Vec<Unit> {
        use rayon::prelude::*;
        if self.missing_line > 0 {
            warnings.push(format!(
                "{} test records without location (line) – run Vitest with includeTaskLocation: true",
                self.missing_line
            ));
        }
        self.units.par_iter_mut().for_each(|u| {
            u.items.sort_unstable();
            u.items.dedup();
        });
        self.units.sort_by(|a, b| a.key.cmp(&b.key));
        self.units
    }
}

/// Interns display paths (case-folded identity for Windows paths).
#[derive(Default)]
pub struct FileTable {
    pub names: Vec<String>,
    map: FxHashMap<String, u32>,
    pub windows: bool,
}

impl FileTable {
    pub fn new(windows: bool) -> Self {
        Self { windows, ..Default::default() }
    }
    pub fn intern(&mut self, display: &str) -> u32 {
        let k = paths::fold_key(display, self.windows);
        if let Some(&i) = self.map.get(&k) {
            return i;
        }
        let i = self.names.len() as u32;
        self.names.push(display.to_string());
        self.map.insert(k, i);
        i
    }
}
