//! "Unnecessary imports" (cs: "Zbytečné importy"): modules evaluated for a test file (fileload.modules) of which no test in
//! that file hit any block during the tests (import-time hits don't count).

use crate::model::Model;
use rustc_hash::FxHashMap;

#[derive(Debug, Clone)]
pub struct ModuleStat {
    pub file: u32,
    /// test files that loaded the module
    pub loaded_by: usize,
    /// test files in which at least one test hit a block of the module
    pub exercised_by: usize,
    /// module has no instrumented blocks (barrel / data / non-instrumented) – use can't be observed
    pub no_blocks: bool,
    /// Σ loadMs over the test files that load the module WITHOUT using it (None when the collector
    /// did not report load times)
    pub load_ms_total: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct TestFileUnused {
    pub test_file: String,
    /// (module, loadMs) loaded but not exercised by any test of the file
    pub unused: Vec<(u32, Option<f64>)>,
    pub loaded: usize,
}

#[derive(Debug, Default)]
pub struct Imports {
    pub modules: Vec<ModuleStat>,
    pub test_files: Vec<TestFileUnused>,
    pub has_load_ms: bool,
}

pub fn analyze(model: &Model) -> Imports {
    if model.fileloads.is_empty() {
        return Imports::default();
    }
    let nf = model.files.len();
    let mut has_blocks = vec![false; nf];
    for it in &model.items {
        has_blocks[it.file as usize] = true;
    }
    // files hit by the tests of each test file
    let mut by_tf: FxHashMap<&str, Vec<u32>> = FxHashMap::default();
    for u in &model.units {
        let v = by_tf.entry(u.file_key()).or_default();
        let mut last = u32::MAX;
        for &i in &u.items {
            let f = model.items[i as usize].file;
            if f != last {
                v.push(f);
                last = f;
            }
        }
    }
    for v in by_tf.values_mut() {
        v.sort_unstable();
        v.dedup();
    }
    let mut loaded_by = vec![0usize; nf];
    let mut exercised_by = vec![0usize; nf];
    let mut ms_total: Vec<Option<f64>> = vec![None; nf];
    let mut test_files = Vec::new();
    let mut has_load_ms = false;
    for fl in &model.fileloads {
        let hit = by_tf.get(fl.test_file.as_str()).map(|v| v.as_slice()).unwrap_or(&[]);
        let mut unused = Vec::new();
        for &m in &fl.modules {
            let ms = fl.load_ms.iter().find(|x| x.0 == m).map(|x| x.1);
            loaded_by[m as usize] += 1;
            if ms.is_some() {
                has_load_ms = true;
            }
            if hit.binary_search(&m).is_ok() {
                exercised_by[m as usize] += 1;
            } else {
                // load time counts only where the module is loaded but unused (VALIDATION R1)
                if let Some(ms) = ms {
                    *ms_total[m as usize].get_or_insert(0.0) += ms;
                }
                unused.push((m, ms));
            }
        }
        unused.sort_by(|a, b| b.1.unwrap_or(0.0).partial_cmp(&a.1.unwrap_or(0.0)).unwrap().then(a.0.cmp(&b.0)));
        if !unused.is_empty() {
            test_files.push(TestFileUnused { test_file: fl.display.clone(), unused, loaded: fl.modules.len() });
        }
    }
    let mut modules: Vec<ModuleStat> = (0..nf)
        .filter(|&f| loaded_by[f] > exercised_by[f])
        .map(|f| ModuleStat {
            file: f as u32,
            loaded_by: loaded_by[f],
            exercised_by: exercised_by[f],
            no_blocks: !has_blocks[f],
            load_ms_total: ms_total[f],
        })
        .collect();
    // rank: total load time when known, else number of test files loading it without using it
    modules.sort_by(|a, b| {
        b.load_ms_total
            .unwrap_or(0.0)
            .partial_cmp(&a.load_ms_total.unwrap_or(0.0))
            .unwrap()
            .then((b.loaded_by - b.exercised_by).cmp(&(a.loaded_by - a.exercised_by)))
            .then(b.loaded_by.cmp(&a.loaded_by))
            .then(a.file.cmp(&b.file))
    });
    let unused_ms = |t: &TestFileUnused| t.unused.iter().map(|x| x.1.unwrap_or(0.0)).sum::<f64>();
    test_files.sort_by(|a, b| {
        unused_ms(b).partial_cmp(&unused_ms(a)).unwrap().then(b.unused.len().cmp(&a.unused.len())).then(a.test_file.cmp(&b.test_file))
    });
    Imports { modules, test_files, has_load_ms }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{FileLoad, Item, Unit};

    #[test]
    fn unused_modules() {
        // files: 0 a.ts (blocks), 1 b.ts (blocks), 2 index.ts (barrel, no blocks)
        let m = Model {
            files: vec!["src/a.ts".into(), "src/b.ts".into(), "src/index.ts".into()],
            items: vec![
                Item { file: 0, lines: vec![1], span: (1, 2) },
                Item { file: 1, lines: vec![1], span: (1, 2) },
            ],
            units: vec![
                Unit { id: "t1".into(), items: vec![0], key: ("test/x.test.ts".into(), 1, "t1".into()), ..Default::default() },
                Unit { id: "t2".into(), items: vec![0, 1], key: ("test/y.test.ts".into(), 1, "t2".into()), ..Default::default() },
            ],
            fileloads: vec![
                FileLoad { test_file: "test/x.test.ts".into(), display: "test/x.test.ts".into(), modules: vec![0, 1, 2], load_ms: vec![(1, 30.0)], reads: None, ..Default::default() },
                FileLoad { test_file: "test/y.test.ts".into(), display: "test/y.test.ts".into(), modules: vec![0, 1, 2], load_ms: vec![(1, 25.0)], reads: None, ..Default::default() },
            ],
            ..Default::default()
        };
        let r = analyze(&m);
        assert!(r.has_load_ms);
        assert_eq!(r.test_files.len(), 2);
        assert_eq!(r.test_files[0].test_file, "test/x.test.ts");
        assert_eq!(r.test_files[0].unused, vec![(1, Some(30.0)), (2, None)]);
        assert_eq!(r.test_files[1].unused, vec![(2, None)]);
        assert_eq!(r.modules[0].file, 1);
        assert_eq!((r.modules[0].loaded_by, r.modules[0].exercised_by), (2, 1));
        assert_eq!(r.modules[0].load_ms_total, Some(30.0)); // only x.test.ts, where b.ts is unused
        assert!(r.modules[1].no_blocks);
    }
}
