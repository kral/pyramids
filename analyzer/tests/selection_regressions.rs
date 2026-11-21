//! Selection regression suite (BLOCKERS-1.0.md, WP1): every false green that REVIEW-2-correctness,
//! -architecture, -security and -usability found in `vto affected`, replayed against the real
//! binary. The fixture `tests/fixtures/lab` is the reviewer's lab project (22 files) with the map
//! that the real collector recorded for it; each scenario mutates a fresh git checkout of the
//! project exactly like `review2-correctness/harness/aff.mjs` and checks that the test file which
//! fails in a full `vitest run` is part of the selection (or that everything runs).
//!
//! No Node / Vitest is needed here. The end-to-end variant that really runs Vitest on the selected
//! filters is `tests/selection_regressions.mjs`.
//!
//! `VTO_TEST_BIN=/path/to/old/vto cargo test --test selection_regressions` runs the same
//! scenarios against another binary (used to reproduce the findings before the fix).

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn bin() -> PathBuf {
    std::env::var_os("VTO_TEST_BIN").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_vto")))
}

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/lab");

fn git(dir: &Path, args: &[&str]) -> String {
    let o = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.email=t@vto", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let (p, name) = (e.path(), e.file_name());
        let name = if name == "gitignore" { ".gitignore".into() } else { name };
        if p.is_dir() {
            copy_dir(&p, &to.join(name));
        } else {
            std::fs::copy(&p, to.join(name)).unwrap();
        }
    }
}

struct Lab {
    /// temp dir holding `p/` (project, git repository) and `raw/` (the map)
    base: PathBuf,
    dir: PathBuf,
    raw: PathBuf,
    sha: String,
}

impl Drop for Lab {
    fn drop(&mut self) {
        if std::env::var_os("VTO_TEST_KEEP").is_none() {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }
}

impl Lab {
    fn new(name: &str) -> Lab {
        let base = std::env::temp_dir().join(format!("vto-sel-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let base = base.canonicalize().unwrap();
        let dir = base.join("p");
        copy_dir(&Path::new(FIXTURE).join("project"), &dir);
        git(&dir, &["init", "-q"]);
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-qm", "base"]);
        let sha = git(&dir, &["rev-parse", "HEAD"]);
        let raw = base.join("raw");
        copy_dir(&Path::new(FIXTURE).join("raw"), &raw);
        let l = Lab { base, dir, raw, sha };
        l.map_meta(|m| m.replace("@GITHEAD@", &l.sha));
        l
    }
    fn map_meta(&self, f: impl Fn(&str) -> String) {
        let p = self.raw.join("w-lab-meta.jsonl");
        std::fs::write(&p, f(&std::fs::read_to_string(&p).unwrap())).unwrap();
    }
    fn map_records(&self, f: impl Fn(&str) -> String) {
        let p = self.raw.join("w-lab-1.jsonl");
        std::fs::write(&p, f(&std::fs::read_to_string(&p).unwrap())).unwrap();
    }
    fn read(&self, f: &str) -> String {
        std::fs::read_to_string(self.dir.join(f)).unwrap()
    }
    fn write(&self, f: &str, s: &str) {
        std::fs::create_dir_all(self.dir.join(f).parent().unwrap()).unwrap();
        std::fs::write(self.dir.join(f), s).unwrap();
    }
    fn edit(&self, f: &str, a: &str, b: &str) {
        let s = self.read(f);
        assert!(s.contains(a), "no {a:?} in {f}");
        self.write(f, &s.replacen(a, b, 1));
    }
    fn git(&self, args: &[&str]) -> String {
        git(&self.dir, args)
    }
    fn run(&self, args: &[&str]) -> Output {
        Command::new(bin()).arg("affected").arg(&self.raw).args(args).current_dir(&self.dir).env_remove("VTO_LANG").output().unwrap()
    }
    /// `vto affected <raw> --git HEAD --vitest [extra]` → selection
    fn select(&self, extra: &[&str]) -> Sel {
        let mut a = vec!["--git", "HEAD", "--vitest"];
        a.extend_from_slice(extra);
        Sel::of(self.run(&a))
    }
}

#[derive(Debug)]
struct Sel {
    code: Option<i32>,
    /// None = run all (`null`)
    filters: Option<Vec<String>>,
    stderr: String,
}

impl Sel {
    fn of(o: Output) -> Sel {
        let out = String::from_utf8_lossy(&o.stdout).trim().to_string();
        let filters: Option<Vec<String>> = serde_json::from_str(&out).unwrap_or_else(|e| panic!("stdout is not a filter array ({e}): {out:?}\n{}", String::from_utf8_lossy(&o.stderr)));
        Sel { code: o.status.code(), filters, stderr: String::from_utf8_lossy(&o.stderr).into_owned() }
    }
    fn run_all(&self) -> bool {
        self.code != Some(0) && self.filters.is_none()
    }
    /// The whole file is selected (bare file filter, no `:line`), or everything runs.
    fn covers(&self, file: &str) -> bool {
        self.run_all() || (self.code == Some(0) && self.filters.as_ref().is_some_and(|f| f.iter().any(|x| x == &format!("./{file}"))))
    }
    #[track_caller]
    fn must_cover(&self, files: &[&str]) -> &Sel {
        // consistency of the two channels: exit 0 ⇔ a filter array, exit 3 ⇔ null
        assert!(matches!((self.code, &self.filters), (Some(0), Some(_)) | (Some(3), None)), "exit code and stdout disagree: {self:?}");
        for f in files {
            assert!(self.covers(f), "FALSE GREEN: {f} is not selected\n{self:#?}");
        }
        self
    }
    #[track_caller]
    fn must_select(&self, files: &[&str]) -> &Sel {
        assert_eq!(self.code, Some(0), "expected a selection, got run-all / error\n{self:#?}");
        self.must_cover(files)
    }
    #[track_caller]
    fn must_run_all(&self) -> &Sel {
        assert_eq!(self.code, Some(3), "{self:#?}");
        assert!(self.filters.is_none(), "{self:#?}");
        self
    }
    #[track_caller]
    fn no_line_filters(&self) -> &Sel {
        for f in self.filters.iter().flatten() {
            let tail = f.rsplit('/').next().unwrap();
            assert!(!tail.contains(':'), "stale file:line filter {f}\n{self:#?}");
        }
        self
    }
    fn count(&self) -> usize {
        self.filters.as_ref().map_or(usize::MAX, |f| f.len())
    }
}

const ALL_TEST_FILES: usize = 22;

// ------------------------------------------------------------------------------------------
// REVIEW-2-correctness scenario table (harness/aff.mjs)
// ------------------------------------------------------------------------------------------

/// S0 control: an edit inside `price()` selects its tests and stays precise.
#[test]
fn s0_control_body_edit_is_precise() {
    let l = Lab::new("s0");
    l.edit("src/price.ts", "total *= 0.8", "total *= 0.7");
    let s = l.select(&[]);
    s.must_select(&["test/price.test.ts"]).no_line_filters();
    assert!(s.count() < ALL_TEST_FILES / 2, "selection lost its precision: {s:#?}");
    assert!(!s.covers("test/lib.test.ts") && !s.covers("test/header.test.ts"), "{s:#?}");
}

/// No change → nothing selected, exit 0, `[]`.
#[test]
fn clean_tree_selects_nothing() {
    let l = Lab::new("clean");
    let s = l.select(&[]);
    assert_eq!((s.code, s.count()), (Some(0), 0), "{s:#?}");
}

/// C-B1 / S4c: a test appended to an existing test file runs (file-level filter).
#[test]
fn b1_s4c_test_appended_to_existing_file() {
    let l = Lab::new("s4c");
    let s = l.read("test/price.test.ts") + "it('NEW regression test appended at the end', () => { expect(price(1, 1)).toBe(999); });\n";
    l.write("test/price.test.ts", &s);
    let s = l.select(&[]);
    s.must_select(&["test/price.test.ts"]).no_line_filters();
    // nothing else but the test files with unrecorded fs inputs (conservative fallback)
    assert!(!s.covers("test/lib.test.ts") && !s.covers("test/docs.test.ts") && s.count() <= 6, "{s:#?}");
}

/// C-B1 / S4, S4b: inserting lines above recorded tests must not produce stale `file:line`
/// filters ("No test found in … in lines 4, 5") – not even with --test-granularity.
#[test]
fn b1_s4_line_shift_in_changed_test_file() {
    let l = Lab::new("s4");
    l.edit("test/price.test.ts", "describe('price', () => {", "it('NEW failing test', () => { expect(1).toBe(2); });\n\n\ndescribe('price', () => {");
    l.select(&[]).must_select(&["test/price.test.ts"]).no_line_filters();
    // --test-granularity: other files may be filtered by line, a CHANGED test file never is
    l.edit("src/lib.mjs", "'hello '", "'hi '");
    let s = l.select(&["--test-granularity"]);
    s.must_select(&["test/price.test.ts"]);
    for f in s.filters.as_ref().unwrap() {
        assert!(!f.starts_with("./test/price.test.ts:"), "{s:#?}");
    }
}

/// C-B1 / S25: a renamed (and edited) test file is selected by its NEW path.
#[test]
fn b1_s25_renamed_test_file_selected_by_new_path() {
    let l = Lab::new("s25");
    l.git(&["mv", "test/page.test.ts", "test/pages.test.ts"]);
    l.edit("test/pages.test.ts", "toContain('<h1>')", "toContain('<h2>')");
    l.edit("src/lib.mjs", "'hello '", "'hello  '.trimEnd() + ' '");
    let s = l.select(&[]);
    s.must_select(&["test/pages.test.ts", "test/lib.test.ts"]).no_line_filters();
    assert!(!s.filters.as_ref().unwrap().iter().any(|f| f.contains("test/page.test.ts")), "old path still requested: {s:#?}");
    // a brand-new test file (untracked) is selected by path as well, without "run all"
    l.write("test/brand-new.test.ts", "import { it } from 'vitest';\nit('x', () => {});\n");
    l.select(&[]).must_select(&["test/brand-new.test.ts", "test/pages.test.ts"]);
    // a deleted test file is not requested any more
    std::fs::remove_file(l.dir.join("test/header.test.ts")).unwrap();
    let s = l.select(&[]);
    assert!(s.code == Some(0) && !s.filters.as_ref().unwrap().iter().any(|f| f.contains("header.test.ts")), "{s:#?}");
}

/// C-B2 / S3: `docs/api.md` (default-ignored `docs/**`, `*.md`) is read through node:fs.
#[test]
fn b2_s3_ignored_doc_read_through_fs() {
    let l = Lab::new("s3");
    l.edit("docs/api.md", "format(n)", "fmt(n)");
    let s = l.select(&[]);
    s.must_select(&["test/docs.test.ts", "test/guards/size.test.ts"]);
    assert!(!s.stderr.contains("ignored docs/api.md"), "{}", s.stderr);
}

/// C-B2 / S3b: `README.md` is a module of the map (`?raw` import).
#[test]
fn b2_s3b_ignored_readme_imported_raw() {
    let l = Lab::new("s3b");
    l.edit("README.md", "price, format", "price");
    l.select(&[]).must_select(&["test/help.test.ts"]);
}

/// C-B2 / S10: the doc only grows; the reader uses `statSync`.
#[test]
fn b2_s10_stat_guard_on_ignored_doc() {
    let l = Lab::new("s10");
    l.write("docs/api.md", &(l.read("docs/api.md") + &"x".repeat(100) + "\n"));
    l.select(&[]).must_select(&["test/guards/size.test.ts"]);
}

/// C-B2 keeps its purpose: an ignored file the map knows nothing about is still ignored.
#[test]
fn b2_unknown_markdown_is_still_ignored() {
    let l = Lab::new("ign");
    l.write("docs/notes.md", "hello\n");
    l.write("CHANGELOG.md", "x\n");
    l.git(&["add", "-A"]);
    l.git(&["commit", "-qm", "docs"]);
    l.map_meta(|m| m.replace(&l.sha, &l.git(&["rev-parse", "HEAD"])));
    l.write("CHANGELOG.md", "y\n");
    let s = l.select(&[]);
    assert_eq!(s.code, Some(0), "{s:#?}");
    assert!(s.stderr.contains("ignored CHANGELOG.md"), "{}", s.stderr);
    // only the test files with unrecorded fs inputs (conservative fallback) may be selected
    for f in s.filters.as_ref().unwrap() {
        assert!(f.contains("/guards/") || f.contains("cli.test"), "{s:#?}");
    }
}

/// C-B3 (analyzer side) / S1: the module is only loaded by `await import()` inside a test, so
/// `fileload.modules` of the recorded map does not list it – but the test has hits in it.
#[test]
fn b3_s1_lazily_imported_module_top_level_change() {
    let l = Lab::new("s1");
    l.edit("src/config.ts", "0.2", "0.3");
    l.select(&[]).must_select(&["test/lazy.test.ts"]);
}

/// C-B3 (analyzer side) / S1b: static importer exists, the app loads the page lazily.
#[test]
fn b3_s1b_lazy_route() {
    let l = Lab::new("s1b");
    l.edit("src/page.ts", "'Orders'", "'Order list'");
    l.select(&[]).must_select(&["test/app.test.ts", "test/page.test.ts"]);
}

/// C-B4 / S2: `label: 'Name'` shares its line with a nested arrow function.
#[test]
fn b4_s2_line_shared_by_top_level_data_and_nested_function() {
    let l = Lab::new("s2");
    l.edit("src/columns.ts", "label: 'Name'", "label: 'Customer'");
    let s = l.select(&[]);
    s.must_select(&["test/header.test.ts", "test/columns.test.ts"]);
    assert!(s.stderr.contains("shares its line with top-level code"), "{}", s.stderr);
}

/// S5: a project `.cjs` loaded through `require()` (recorded as an fs read by the CJS loader).
#[test]
fn s5_require_of_project_cjs() {
    let l = Lab::new("s5");
    l.edit("src/legacy.cjs", "LIMIT = 10", "LIMIT = 20");
    l.select(&[]).must_select(&["test/uses-legacy.test.ts", "test/legacy-direct.test.ts"]);
}

/// C-M1 / S6: the test spawns `bin/cli.mjs`, which imports the changed module in another process.
#[test]
fn m1_s6_child_process() {
    let l = Lab::new("s6");
    l.edit("src/lib.mjs", "'hello '", "'hi '");
    let s = l.select(&[]);
    s.must_select(&["test/cli.test.ts", "test/lib.test.ts"]);
    assert!(s.stderr.contains("unrecorded file-system inputs"), "{}", s.stderr);
}

/// C-M1 / S-N2a / S9: six source guards read `src/price.ts` through globSync, tinyglobby, an fd,
/// a FileHandle, a shell command and a worker thread. All six must be selected.
#[test]
fn m1_s9_fs_guards_fd_filehandle_shell_worker() {
    let l = Lab::new("s9");
    l.edit("src/price.ts", "return Math.round(total * 100) / 100;", "return Math.round(total * 100) / 100 + 0 * Math.random();");
    l.select(&[]).must_select(&[
        "test/guards/no-random-glob.test.ts",
        "test/guards/no-random-tinyglobby.test.ts",
        "test/guards/no-random-fd.test.ts",
        "test/guards/no-random-fh.test.ts",
        "test/guards/no-random-shell.test.ts",
        "test/guards/no-random-worker.test.ts",
        "test/price.test.ts",
    ]);
}

/// C-M1: the collector's verdict wins over the source heuristics in both directions.
#[test]
fn m1_reads_complete_flag() {
    // readsComplete:true everywhere → the heuristics are off, the selection is precise again
    let l = Lab::new("rc1");
    l.map_records(|m| m.replace("\"t\":\"fileload\",", "\"t\":\"fileload\",\"readsComplete\":true,"));
    l.edit("src/lib.mjs", "'hello '", "'hi '");
    let s = l.select(&[]);
    s.must_select(&["test/lib.test.ts"]);
    assert!(!s.covers("test/cli.test.ts") && !s.covers("test/guards/no-random-fd.test.ts"), "{s:#?}");
    // readsComplete:false on one plain test file → selected for every change
    let l = Lab::new("rc2");
    l.map_records(|m| m.replace("\"t\":\"fileload\",\"testFile\":\"test/header.test.ts\",", "\"t\":\"fileload\",\"readsComplete\":false,\"testFile\":\"test/header.test.ts\","));
    l.edit("src/lib.mjs", "'hello '", "'hi '");
    l.select(&[]).must_select(&["test/header.test.ts", "test/lib.test.ts"]);
}

/// C-M2 / S7: `git mv` of a source file into a directory scanned by `import.meta.glob`.
/// A rename is delete + add; the new path is an unknown new file ⇒ run all.
#[test]
fn m2_s7_rename_into_glob_dir() {
    let l = Lab::new("s7");
    l.git(&["mv", "src/disabled/extra.ts", "src/plugins/extra.ts"]);
    l.edit("test/extra.test.ts", "../src/disabled/extra", "../src/plugins/extra");
    let s = l.select(&[]);
    s.must_cover(&["test/registry.test.ts", "test/extra.test.ts"]);
    s.must_run_all();
    assert!(s.stderr.contains("src/plugins/extra.ts: new file"), "{}", s.stderr);
}

/// C-M2 / D7b: a brand-new source file in the glob directory ⇒ run all.
#[test]
fn m2_d7b_new_source_file() {
    let l = Lab::new("d7b");
    l.write("src/plugins/b.ts", "export const name = 'b';\n");
    l.select(&[]).must_run_all();
}

/// C-M2 with a user-supplied diff that carries rename headers (`--diff`): same rule.
#[test]
fn m2_rename_in_supplied_diff() {
    let l = Lab::new("rn");
    let diff = "diff --git a/src/disabled/extra.ts b/src/plugins/extra.ts\nsimilarity index 100%\nrename from src/disabled/extra.ts\nrename to src/plugins/extra.ts\n";
    std::fs::write(l.base.join("d.diff"), diff).unwrap();
    let d = l.base.join("d.diff");
    let s = Sel::of(l.run(&["--diff", d.to_str().unwrap(), "--base", &l.sha, "--vitest"]));
    s.must_run_all();
}

/// C-M3: a test that failed while the map was recorded has truncated coverage – its file is
/// always selected, also for a change it has no hit in and for an empty diff.
#[test]
fn m3_test_failed_at_collection() {
    let l = Lab::new("m3");
    l.map_records(|m| {
        let needle = "\"file\":\"test/header.test.ts\"";
        m.lines()
            .map(|line| if line.contains("\"t\":\"test\"") && line.contains(needle) { line.replace("\"state\":\"pass\"", "\"state\":\"fail\"") } else { line.to_string() })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n"
    });
    let s = l.select(&[]);
    s.must_select(&["test/header.test.ts"]);
    assert!(s.stderr.contains("a test failed when the map was recorded"), "{}", s.stderr);
    l.edit("src/lib.mjs", "'hello '", "'hi '");
    l.select(&[]).must_select(&["test/header.test.ts", "test/lib.test.ts"]);
}

/// C-M3: a test file without `fileload` record (the file crashed before `afterAll`), and a file
/// whose fileload carries `error: true`.
#[test]
fn m3_missing_or_errored_fileload() {
    let l = Lab::new("m3b");
    l.map_records(|m| m.lines().filter(|x| !(x.contains("\"t\":\"fileload\"") && x.contains("\"testFile\":\"test/header.test.ts\""))).collect::<Vec<_>>().join("\n") + "\n");
    l.edit("src/lib.mjs", "'hello '", "'hi '");
    l.select(&[]).must_select(&["test/header.test.ts"]);
    let l = Lab::new("m3c");
    l.map_records(|m| m.replace("\"t\":\"fileload\",\"testFile\":\"test/header.test.ts\",", "\"t\":\"fileload\",\"error\":true,\"testFile\":\"test/header.test.ts\","));
    l.edit("src/lib.mjs", "'hello '", "'hi '");
    l.select(&[]).must_select(&["test/header.test.ts"]);
}

/// C-M3 / C-M5: `meta.testFiles` lists a collected test file that produced no record at all.
#[test]
fn m3_collected_file_without_records() {
    let l = Lab::new("m3d");
    l.write("test/all-skipped.test.ts", "import { it } from 'vitest';\nit.skip('x', () => {});\n");
    l.git(&["add", "-A"]);
    l.git(&["commit", "-qm", "skipped"]);
    let head = l.git(&["rev-parse", "HEAD"]);
    l.map_meta(|m| m.replace(&l.sha, &head).replace("\"setupFiles\":[]", "\"setupFiles\":[],\"testFiles\":[\"test/all-skipped.test.ts\",\"test/price.test.ts\"]"));
    l.edit("src/lib.mjs", "'hello '", "'hi '");
    l.select(&[]).must_select(&["test/all-skipped.test.ts"]);
}

/// C-M5 / S8b: `it.runIf(process.env.FULL)` did not run when the map was recorded. The file is
/// selected as a whole, so the test runs when the gate enables it.
#[test]
fn m5_s8b_test_skipped_at_collection() {
    let l = Lab::new("s8");
    l.edit("src/price.ts", "' Kč'", "' CZK'");
    l.select(&[]).must_select(&["test/ci-only.test.ts"]).no_line_filters();
}

/// C-M5: a recorded `skip` test has no hits; its file is selected when a module it loads changes,
/// even with --test-granularity and although no recorded test of the file hits the change.
#[test]
fn m5_recorded_skip_selects_file_when_affected() {
    let l = Lab::new("m5");
    l.map_records(|m| {
        m.to_string() + "{\"t\":\"test\",\"file\":\"test/header.test.ts\",\"name\":\"only in CI\",\"line\":9,\"state\":\"skip\",\"hits\":{}}\n"
    });
    // header.test.ts does not load src/price.ts → its skipped test is not a reason to run it
    l.edit("src/price.ts", "total *= 0.8", "total *= 0.7");
    assert!(!l.select(&["--test-granularity"]).covers("test/header.test.ts"));
    let l2 = Lab::new("m5b");
    l2.map_records(|m| {
        m.to_string() + "{\"t\":\"test\",\"file\":\"test/docs.test.ts\",\"name\":\"only in CI\",\"line\":9,\"state\":\"skip\",\"hits\":{}}\n"
    });
    l2.edit("src/price.ts", "total *= 0.8", "total *= 0.7");
    let s = l2.select(&["--test-granularity"]);
    s.must_select(&["test/docs.test.ts"]);
    assert!(s.filters.as_ref().unwrap().contains(&"./test/docs.test.ts".to_string()), "{s:#?}");
}

// ------------------------------------------------------------------------------------------
// REVIEW-2-architecture
// ------------------------------------------------------------------------------------------

/// A-1 (N1): the root reached through a symlink gives the same answer as the real path.
#[cfg(unix)]
#[test]
fn a1_root_through_symlink() {
    let l = Lab::new("a1");
    l.edit("src/price.ts", "total *= 0.8", "total *= 0.7");
    let real = l.select(&[]);
    let link = l.base.join("link");
    std::os::unix::fs::symlink(&l.dir, &link).unwrap();
    let o = Command::new(bin()).arg("affected").arg(&l.raw).args(["--git", "HEAD", "--vitest", "--root"]).arg(&link).current_dir("/").output().unwrap();
    let via = Sel::of(o);
    assert_eq!(via.code, Some(0), "{via:#?}");
    assert_eq!(via.filters, real.filters);
    assert!(via.count() > 0);
    // and with the link as the working directory
    let o = Command::new(bin()).arg("affected").arg(&l.raw).args(["--git", "HEAD", "--vitest"]).current_dir(&link).output().unwrap();
    assert_eq!(Sel::of(o).filters, real.filters);
}

/// A-1: a root that does not hold the mapped project ⇒ run all with a message naming the roots;
/// never "0 tests selected".
#[test]
fn a1_wrong_root_is_run_all() {
    let l = Lab::new("a1b");
    l.edit("README.md", "price, format", "price"); // a change that used to be "ignored" → 0 selected
    let other = l.base.join("other");
    std::fs::create_dir_all(&other).unwrap();
    git(&other, &["init", "-q"]);
    std::fs::write(other.join("README.md"), "x\n").unwrap();
    let o = Command::new(bin()).arg("affected").arg(&l.raw).args(["--git", "HEAD", "--vitest", "--allow-stale", "--root"]).arg(&other).output().unwrap();
    let s = Sel::of(o);
    s.must_run_all();
    assert!(s.stderr.contains("root mismatch") && s.stderr.contains("/vto-fixture/lab"), "{}", s.stderr);
    // sub-directory of the project as root: same protection
    let o = Command::new(bin()).arg("affected").arg(&l.raw).args(["--git", "HEAD", "--vitest", "--root"]).arg(l.dir.join("docs")).output().unwrap();
    Sel::of(o).must_run_all();
}

/// A-1 / D2.6: maps are portable – the recorded `meta.root` (another machine, another CI work
/// directory) does not matter as long as the files are below the reader's root.
#[test]
fn a1_map_recorded_under_another_root_is_portable() {
    let l = Lab::new("a1c");
    l.map_meta(|m| m.replace("/vto-fixture/lab", "/agent/_work/1/s"));
    l.edit("src/price.ts", "total *= 0.8", "total *= 0.7");
    l.select(&[]).must_select(&["test/price.test.ts"]);
    // format 2.0 style: absolute paths below the recorded root
    l.map_records(|m| m.replace("\"src/", "\"/agent/_work/1/s/src/").replace("\"test/", "\"/agent/_work/1/s/test/"));
    let s = l.select(&[]);
    s.must_select(&["test/price.test.ts"]);
    assert!(s.count() < ALL_TEST_FILES / 2, "{s:#?}");
}

/// A-5 (N3): the same commit checked out with CRLF line endings (and a BOM) is not "stale": the
/// content hash ignores both, so selection stays block-level.
#[test]
fn a5_crlf_checkout_keeps_block_precision() {
    let l = Lab::new("a5");
    // the map's hash was taken from the CRLF + BOM working file by a D1 collector (= hash of the
    // LF text) – and git stores LF
    let lf = l.read("src/price.ts");
    assert!(!lf.contains('\r'));
    let crlf = format!("\u{feff}{}", lf.replace('\n', "\r\n"));
    assert_eq!(vto::store::content_hash(crlf.as_bytes()), vto::store::content_hash(lf.as_bytes()));
    assert_ne!(vto::store::sha256_hex(crlf.as_bytes()), vto::store::sha256_hex(lf.as_bytes()));
    // reverse direction (the reviewer's repro): a pre-D1 collector hashed the CRLF working file
    l.git(&["config", "core.autocrlf", "true"]);
    l.write("src/price.ts", &lf.replace('\n', "\r\n").replace("total *= 0.8", "total *= 0.7"));
    let s = l.select(&[]);
    s.must_select(&["test/price.test.ts"]);
    assert!(!s.stderr.contains("stale map"), "{}", s.stderr);
    assert!(s.count() < ALL_TEST_FILES / 2, "CRLF checkout lost block precision: {s:#?}");
    // an untouched file that is CRLF on disk is not reported as hidden change
    l.write("src/columns.ts", &l.read("src/columns.ts").replace('\n', "\r\n"));
    let s2 = l.select(&[]);
    assert_eq!(s2.filters, s.filters, "{s2:#?}");
}

/// A real content mismatch (map recorded from other content than the base commit) still widens
/// the selection to every loader of the file.
#[test]
fn a5_real_hash_mismatch_is_stale() {
    let l = Lab::new("a5b");
    l.map_records(|m| m.replace("6e2adfda58f11a248f28b3a9e13af8c7632c72bfd4139c531bf1a36fadf66d1d", &"ab".repeat(32)));
    l.edit("src/price.ts", "total *= 0.8", "total *= 0.7");
    let s = l.select(&[]);
    s.must_select(&["test/price.test.ts", "test/docs.test.ts", "test/ci-only.test.ts"]);
    assert!(s.stderr.contains("stale map"), "{}", s.stderr);
}

/// correctness m1: an edit hidden from `git diff` (`skip-worktree`) is found through the
/// recorded content hash.
#[test]
fn m1_minor_skip_worktree_edit_is_seen() {
    let l = Lab::new("skipwt");
    l.git(&["update-index", "--skip-worktree", "src/price.ts"]);
    l.edit("src/price.ts", "total *= 0.8", "total *= 0.7");
    let s = l.select(&[]);
    s.must_select(&["test/price.test.ts"]);
    assert!(s.stderr.contains("although git reports no change"), "{}", s.stderr);
}

/// U-7 / usability A1: a path reported in NFD (macOS) matches the NFC key of the map.
#[test]
fn nfd_path_in_diff_matches_nfc_map() {
    let l = Lab::new("nfd");
    let nfc = "src/\u{10d}en\u{ed}k.ts";
    let nfd = "src/c\u{30c}eni\u{301}k.ts";
    l.write(nfc, "export function cena(n) {\n  if (n > 1) return 2;\n  return 1;\n}\n");
    l.git(&["add", "-A"]);
    l.git(&["commit", "-qm", "cenik"]);
    let head = l.git(&["rev-parse", "HEAD"]);
    l.map_meta(|m| m.replace(&l.sha, &head));
    l.map_records(|m| {
        format!(
            "{m}{{\"t\":\"file\",\"file\":\"{nfc}\",\"blocks\":[[1,7,4,1,\"f\"],[2,13,2,22,\"b\"]]}}\n{{\"t\":\"test\",\"file\":\"test/header.test.ts\",\"name\":\"cenik\",\"line\":99,\"state\":\"pass\",\"hits\":{{\"{nfc}\":[0,1]}}}}\n"
        )
    });
    let diff = format!("--- a/{nfd}\n+++ b/{nfd}\n@@ -2 +2 @@\n-  if (n > 1) return 2;\n+  if (n > 1) return 3;\n");
    let d = l.base.join("nfd.diff");
    std::fs::write(&d, diff).unwrap();
    let s = Sel::of(l.run(&["--diff", d.to_str().unwrap(), "--base", &head, "--vitest"]));
    s.must_select(&["test/header.test.ts"]);
}

// ------------------------------------------------------------------------------------------
// REVIEW-2-usability
// ------------------------------------------------------------------------------------------

/// U-5 (R6b): the map was recorded at commit A, the user committed B and asks `--git HEAD`.
/// The diff is taken from the map's commit instead of "run all", and the tool says so.
#[test]
fn u5_map_at_older_commit_diffs_from_map_commit() {
    let l = Lab::new("u5");
    l.edit("src/price.ts", "total *= 0.8", "total *= 0.7");
    l.git(&["commit", "-qam", "B"]);
    // working tree clean, HEAD = B, map = A → the committed edit must still select its tests
    let s = l.select(&[]);
    s.must_select(&["test/price.test.ts"]);
    assert!(s.count() < ALL_TEST_FILES / 2, "{s:#?}");
    assert!(s.stderr.contains("the map was recorded at") && s.stderr.contains("working tree"), "{}", s.stderr);
    // plus an uncommitted edit on top
    l.edit("src/lib.mjs", "'hello '", "'hi '");
    l.select(&[]).must_select(&["test/price.test.ts", "test/lib.test.ts"]);
    // --expect-commit keeps the strict behaviour
    Sel::of(l.run(&["--git", "HEAD", "--vitest", "--expect-commit", &l.git(&["rev-parse", "HEAD"])])).must_run_all();
}

/// U-5 fail-safe: a map commit that this clone does not have ⇒ run all, with a hint what to do.
#[test]
fn u5_unknown_map_commit_is_run_all_with_hint() {
    let l = Lab::new("u5b");
    l.map_meta(|m| m.replace(&l.sha, "0123456789012345678901234567890123456789"));
    l.edit("src/price.ts", "total *= 0.8", "total *= 0.7");
    let s = l.select(&[]);
    s.must_run_all();
    assert!(s.stderr.contains("not a commit of this clone") && s.stderr.contains("record a new map"), "{}", s.stderr);
}

/// U-5 (R6a): map recorded on a dirty tree. With `meta.dirtyFiles` the selection works: files
/// unchanged since recording are not "changed" (although git reports them), files that changed
/// again are selected at file level.
#[test]
fn u5_dirty_map_with_dirty_files() {
    let l = Lab::new("u5c");
    // dirty at record time: src/lib.mjs (hash of that content in the map), README.md
    l.edit("src/lib.mjs", "'hello '", "'hello  '.trimEnd() + ' '");
    let h = vto::store::content_hash(l.read("src/lib.mjs").as_bytes());
    let h_readme = vto::store::content_hash(l.read("README.md").as_bytes());
    l.map_meta(|m| {
        m.replace("\"dirty\":false", &format!("\"dirty\":true,\"dirtyFiles\":[{{\"path\":\"src/lib.mjs\",\"sha256\":\"{h}\"}},{{\"path\":\"README.md\",\"sha256\":\"{h_readme}\"}}]"))
    });
    // nothing changed since the recording → nothing selected, although `git diff` is not empty
    let s = l.select(&[]);
    assert_eq!((s.code, s.count()), (Some(0), 0), "{s:#?}");
    assert!(s.stderr.contains("recorded on a dirty working tree"), "{}", s.stderr);
    // a clean file is edited → block-level selection as usual
    l.edit("src/price.ts", "total *= 0.8", "total *= 0.7");
    let s = l.select(&[]);
    s.must_select(&["test/price.test.ts"]);
    assert!(!s.covers("test/lib.test.ts"), "{s:#?}");
    // the dirty file is edited again → its loaders
    l.edit("src/lib.mjs", "trimEnd()", "trim()");
    l.select(&[]).must_select(&["test/price.test.ts", "test/lib.test.ts"]);
    // … or reverted to the committed content (git now reports nothing for it) → still selected
    l.git(&["checkout", "--", "src/lib.mjs"]);
    l.select(&[]).must_select(&["test/lib.test.ts"]);
}

/// U-5 fail-safe: a dirty map without the list of modified files cannot be trusted ⇒ run all,
/// and the message says how to get out of it.
#[test]
fn u5_dirty_map_without_list_is_run_all() {
    let l = Lab::new("u5d");
    l.map_meta(|m| m.replace("\"dirty\":false", "\"dirty\":true"));
    l.edit("src/price.ts", "total *= 0.8", "total *= 0.7");
    let s = l.select(&[]);
    s.must_run_all();
    assert!(s.stderr.contains("dirty working tree") && s.stderr.contains("commit first"), "{}", s.stderr);
}

/// U-11 (R5): a mistyped map path is an error (exit 2), not "run all" (exit 3). stdout still
/// carries the run-all sentinel so that a pipeline which drops the exit code runs everything.
#[test]
fn u11_mistyped_map_path_is_exit_2() {
    let l = Lab::new("u11");
    for (args, expect_out) in [
        (vec!["--git", "HEAD", "--vitest"], "null\n".as_bytes()),
        (vec!["--git", "HEAD", "--vitest", "--print0"], b".\0".as_slice()),
    ] {
        let o = Command::new(bin()).arg("affected").arg(l.base.join("no-such-raw")).args(&args).current_dir(&l.dir).output().unwrap();
        assert_eq!(o.status.code(), Some(2), "{}", String::from_utf8_lossy(&o.stderr));
        assert_eq!(o.stdout, expect_out);
        let e = String::from_utf8_lossy(&o.stderr);
        assert!(e.contains("error:") && e.contains("no-such-raw"), "{e}");
    }
    // an existing directory without raw files: same
    std::fs::create_dir_all(l.base.join("empty")).unwrap();
    let o = Command::new(bin()).arg("affected").arg(l.base.join("empty")).args(["--git", "HEAD", "--json"]).current_dir(&l.dir).output().unwrap();
    assert_eq!(o.status.code(), Some(2));
    let j: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap();
    assert_eq!((j["runAll"].as_bool(), j["error"].as_bool()), (Some(true), Some(true)));
    // a valid map that cannot answer stays exit 3
    l.write("package.json", "{}\n");
    l.select(&[]).must_run_all();
}

/// U-11 (R4): usage errors are short, on stderr, exit 2, and contain no `\u{a}`; --help and
/// --version print to stdout with exit 0.
#[test]
fn u11_usage_output() {
    let run = |args: &[&str]| Command::new(bin()).args(args).output().unwrap();
    for args in [&["--bogus"][..], &["affected"][..], &[][..], &["affected", "x", "--git"][..]] {
        let o = run(args);
        let e = String::from_utf8_lossy(&o.stderr);
        assert_eq!(o.status.code(), Some(2), "{args:?}: {e}");
        assert!(!e.contains("\\u{a}"), "{args:?}: escaped newlines in {e}");
        assert!(o.stdout.is_empty());
    }
    let e = String::from_utf8_lossy(&run(&["--bogus"]).stderr).into_owned();
    assert!(e.lines().count() <= 3 && e.contains("--help"), "{e}");
    let o = run(&["--help"]);
    assert_eq!(o.status.code(), Some(0));
    let h = String::from_utf8_lossy(&o.stdout);
    assert!(h.lines().count() > 30 && h.contains("USAGE") && !h.contains("\\u{a}"));
    let o = run(&["--version"]);
    assert_eq!(o.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&o.stdout).starts_with("vto "));
}

/// `--json` is the machine contract of the daemon: `files` is the selection (whole files, new
/// test files included), `filters` equals the `--vitest` output, names are not HTML-escaped.
#[test]
fn json_contract() {
    let l = Lab::new("json");
    l.edit("src/price.ts", "total *= 0.8", "total *= 0.7");
    l.write("test/brand-new.test.ts", "import { it } from 'vitest';\nit('a > b & <c>', () => {});\n");
    let o = l.run(&["--git", "HEAD", "--json"]);
    assert_eq!(o.status.code(), Some(0));
    let out = String::from_utf8_lossy(&o.stdout).into_owned();
    assert!(!out.contains("&gt;") && !out.contains("&amp;"), "{out}");
    let j: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(j["runAll"], false);
    let files: Vec<&str> = j["files"].as_array().unwrap().iter().map(|f| f["file"].as_str().unwrap()).collect();
    assert!(files.contains(&"test/price.test.ts") && files.contains(&"test/brand-new.test.ts"), "{files:?}");
    let new = j["files"].as_array().unwrap().iter().find(|f| f["file"] == "test/brand-new.test.ts").unwrap();
    assert_eq!((new["known"].as_bool(), new["whole"].as_bool()), (Some(false), Some(true)));
    assert!(j["tests"].as_array().unwrap().iter().any(|t| t["name"] == "price > vip bulk" && t["file"] == "test/price.test.ts"));
    let filters: Vec<String> = serde_json::from_value(j["filters"].clone()).unwrap();
    assert_eq!(Some(filters), l.select(&[]).filters);
    // plain output: ids as they are (" > " separators, no entities)
    let o = l.run(&["--git", "HEAD"]);
    let plain = String::from_utf8_lossy(&o.stdout).into_owned();
    assert!(plain.contains("test/price.test.ts:7 > price > vip bulk") && !plain.contains("&gt;"), "{plain}");
}

/// A stored map (`vto pack`) answers like the raw directory – including fs reads, which the old
/// pack dropped (so C-B2 would have come back for packed maps).
#[test]
fn packed_map_selects_like_raw() {
    let l = Lab::new("pack");
    let packed = l.base.join("map.jsonl");
    let o = Command::new(bin()).arg("pack").arg(&l.raw).arg("--out").arg(&packed).current_dir(&l.dir).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let text = std::fs::read_to_string(&packed).unwrap();
    assert!(text.contains("\"reads\":[") && !text.contains("/vto-fixture/lab"), "stored map lost reads or kept the absolute root");
    for (file, a, b) in [
        ("docs/api.md", "format(n)", "fmt(n)"),
        ("src/columns.ts", "label: 'Name'", "label: 'Customer'"),
        ("src/price.ts", "total *= 0.8", "total *= 0.7"),
        ("src/config.ts", "0.2", "0.3"),
    ] {
        l.git(&["checkout", "-q", "--", "."]);
        l.edit(file, a, b);
        let raw = l.select(&[]);
        let o = Command::new(bin()).arg("affected").arg(&packed).args(["--git", "HEAD", "--vitest"]).current_dir(&l.dir).output().unwrap();
        let stored = Sel::of(o);
        assert_eq!(stored.code, Some(0), "{stored:#?}");
        assert_eq!(stored.filters, raw.filters, "{file}");
        assert!(raw.count() > 0);
    }
}
