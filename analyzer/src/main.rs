use std::path::{Path, PathBuf};
use std::process::exit;
use std::time::Instant;
use vto::sanitize::term;
use vto::git::{self, Git};
use vto::{affected, analysis, imports, paths, raw, report, store};

const USAGE: &str = "\
vto – analysis of overlapping Vitest tests from per-test coverage

USAGE:
  vto <raw> [--out DIR] [--full] [--top N] [--threshold 0.9] [--root DIR] [--quiet] [--timings]
            [--max-supersets 5] [--max-near 10000] [--max-near-per-test 20] [--common-cutoff 0.5]
            [--expect-commit SHA] [limits]
  vto affected <raw> (--git <base> | --diff <file|-> --base SHA) [--root DIR]
            [--json | --vitest [--print0]] [--ignore GLOB]... [--no-default-ignore] [--run-all GLOB]...
            [--importers] [--test-granularity] [--allow-stale] [--expect-commit SHA] [--quiet] [limits]
  vto pack <raw> --out FILE [--root DIR]      write a stored map (one portable JSONL file)
  vto --help | --version

  <raw>                 directory with *.jsonl raw files (searched recursively, e.g. one dir per shard;
                        symbolic links are not followed) or a stored map file from `vto pack`.
                        Maps must only be produced by trusted jobs (protected branches) – the analyzer
                        trusts their content (see FORMAT.md, \"Map provenance\").
  --out DIR             report folder (default overlap-report); for `pack`: output file
  --full                report.md with every group, every list row and the table of all tests
                        (default: compact – top 20 groups, 10 tests per group, 50 rows per list;
                        report.json is always complete)
  --top N               max rows per list in report.md (default 50, with --full unlimited)
  --threshold X         Jaccard threshold for near-duplicate pairs (default 0.9)
  --root DIR            project root (default: current dir). Resolved to its real path; paths of
                        the map are relative to it.
  --max-supersets K     supersets stored per contained test (default 5; the total count is kept)
  --max-near N          near pairs stored in report.json (default 10000; the total count is kept)
  --max-near-per-test N near pairs kept per test (default 20)
  --common-cutoff X     ignore items covered by > X of the tests for near-duplicate similarity
                        (shared setup / app shell; default 0.5, active from 100 tests; 1 = off)
  --max-near-candidates N  bound on verified candidate pairs (default 10000000; result marked incomplete)
  --timings             print per-phase timings to stderr
  --lang en|cs          language of report.md (default en; also VTO_LANG=cs). report.json is
                        language-independent; CLI messages are English.
  --expect-commit SHA   refuse a map recorded at another commit (report: error, affected: run all)
limits (inputs above them are an error, never silently cut):
  --max-raw-bytes N (default 2 GiB)  --max-line-bytes N (16 MiB)  --max-records N (20 M)

affected:
  --git BASE            select for the working tree. BASE must be a revision (not an option). The
                        diff is always taken from the commit the MAP was recorded at to the working
                        tree (plus untracked files); when that is not BASE, vto says so. git runs
                        hardened (contracts/DECISIONS.md D4: no fsmonitor, hooks, external diff,
                        textconv, rename detection).
  --diff F              unified diff (map commit → now), '-' = stdin; requires --base SHA (or
                        --allow-stale). Renames in the diff are handled as delete + add.
  --base SHA            base commit of --diff
  --allow-stale         accept a map without gitHead / recorded at another commit / on a dirty tree
                        as it is, and skip the content-hash checks (for callers that track file
                        versions themselves)
  --json                {\"runAll\":bool,\"reasons\":[…],\"files\":[{file,whole,known}],\"filters\":[…]|null,
                        \"tests\":[{id,file,line,name}]}. `files` is the selection: a selected file runs
                        completely, including tests the map does not know.
  --vitest              vitest filters as a JSON array of strings: one \"./file\" per selected test
                        file. Run all is printed as `null`, nothing selected as `[]`. With --print0:
                        NUL-separated filters; run all = the single filter \".\" (matches every test
                        file), nothing selected = no output. Recommended:
                          vto affected … --vitest --print0 | xargs -0 -r npx vitest run
                        and still check vto's exit code.
  --test-granularity    \"./file:line\" filters for test files in which only single tests matched
                        (never for a changed, new or untrusted test file). Opt-in: coverage can
                        depend on earlier tests of the file, and tests added later are not run.
  --ignore GLOB         ignore changed paths the map knows nothing about (default: *.md, docs/**);
                        repeatable / comma separated. A file that tests import or read is never ignored.
  --no-default-ignore   drop the default ignore list
  --run-all GLOB        additional \"run everything\" triggers (defaults: package.json, lockfiles,
                        vite/vitest config, tsconfig*, .env*, *.setup.*, .gitattributes, __mocks__/**,
                        setupFiles from meta)
  --importers           also select every test file that loads a changed module (file-level safety
                        net, ≈ vitest related; catches edits that break module loading)
  --innermost           EXPERIMENTAL, unsafe: map a changed line only to innermost blocks

EXIT CODES (contracts/DECISIONS.md D3):
  0  ok – for `affected`: the printed selection is complete (may be empty)
  2  usage or input error (bad option, missing / unreadable / unsupported map). `affected` still
     prints the run-all sentinel on stdout, so a pipeline without exit-code check runs everything.
  3  `affected`: run all tests (unknown or new files, config change, git error, stale or
     inconsistent map, root mismatch)
  Treat any other non-zero exit as \"run all\" too.";

struct Opts {
    raw: Option<PathBuf>,
    out: Option<PathBuf>,
    root: Option<PathBuf>,
    top: Option<usize>,
    quiet: bool,
    timings: bool,
    an: analysis::Opts,
    lim: raw::Limits,
    diff: Option<String>,
    git: Option<String>,
    base: Option<String>,
    expect_commit: Option<String>,
    allow_stale: bool,
    lang: Option<String>,
    vitest: bool,
    print0: bool,
    json: bool,
    full: bool,
    aff: affected::AffectedOpts,
}

/// Error exit (2). The message may carry untrusted text and is sanitised.
fn die(msg: &str) -> ! {
    eprintln!("vto: error: {}", term(msg));
    exit(2)
}

/// Usage error (2): the message plus a pointer to --help – never the whole usage text, and never
/// through the sanitiser (which would print its newlines as `\u{a}`, U-11).
fn die_usage(msg: &str) -> ! {
    eprintln!("vto: error: {}", term(msg));
    eprintln!("vto: see `vto --help`");
    exit(2)
}

fn parse(args: &[String]) -> Opts {
    let mut o = Opts {
        raw: None,
        out: None,
        root: None,
        top: None,
        quiet: false,
        timings: false,
        an: analysis::Opts::default(),
        lim: raw::Limits::default(),
        diff: None,
        git: None,
        base: None,
        expect_commit: None,
        allow_stale: false,
        lang: None,
        vitest: false,
        print0: false,
        json: false,
        full: false,
        aff: affected::AffectedOpts::default(),
    };
    let mut user_ignore = Vec::new();
    let mut default_ignore = true;
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        let mut val = || -> String {
            i += 1;
            args.get(i).cloned().unwrap_or_else(|| die_usage(&format!("missing value for {a}")))
        };
        let num = |v: String| -> u64 { v.parse().unwrap_or_else(|_| die_usage(&format!("invalid value for {a}"))) };
        match a {
            "-h" | "--help" => {
                println!("{USAGE}");
                exit(0)
            }
            "-V" | "--version" => {
                println!("vto {}", env!("CARGO_PKG_VERSION"));
                exit(0)
            }
            "--full" => o.full = true,
            "--out" => o.out = Some(PathBuf::from(val())),
            "--threshold" => o.an.threshold = val().parse().unwrap_or_else(|_| die("invalid --threshold")),
            "--root" => o.root = Some(PathBuf::from(val())),
            "--top" => o.top = Some(num(val()) as usize),
            "--max-supersets" => o.an.max_supersets = num(val()) as usize,
            "--max-near" => o.an.max_near_total = num(val()) as usize,
            "--max-near-per-test" => o.an.max_near_per_test = num(val()) as usize,
            "--common-cutoff" => o.an.common_cutoff = val().parse().unwrap_or_else(|_| die("invalid --common-cutoff")),
            "--max-near-candidates" => o.an.max_near_candidates = num(val()),
            "--max-raw-bytes" => o.lim.max_raw_bytes = num(val()),
            "--max-line-bytes" => o.lim.max_line_bytes = num(val()) as usize,
            "--max-records" => o.lim.max_records = num(val()) as usize,
            "--diff" => o.diff = Some(val()),
            "--git" => o.git = Some(val()),
            "--base" => o.base = Some(val()),
            "--expect-commit" => o.expect_commit = Some(val()),
            "--allow-stale" => o.allow_stale = true,
            "--lang" => o.lang = Some(val()),
            "--ignore" => user_ignore.extend(val().split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty())),
            "--no-default-ignore" => default_ignore = false,
            "--run-all" => o.aff.run_all.extend(val().split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty())),
            "--quiet" | "-q" => o.quiet = true,
            "--timings" => o.timings = true,
            "--vitest" => o.vitest = true,
            "--print0" => o.print0 = true,
            "--json" => o.json = true,
            "--innermost" => o.aff.innermost = true,
            "--importers" => o.aff.importers = true,
            "--test-granularity" => o.aff.test_granularity = true,
            "--broad" => {} // default since REVIEW-1
            s if s.starts_with('-') && s != "-" => die_usage(&format!("unknown option {s}")),
            s => {
                if o.raw.is_some() {
                    die_usage(&format!("unexpected argument {s}"));
                }
                o.raw = Some(PathBuf::from(s));
            }
        }
        i += 1;
    }
    if !default_ignore {
        o.aff.ignore.clear();
    }
    o.aff.ignore.extend(user_ignore);
    o
}

fn same_commit(a: &str, b: &str) -> bool {
    let (a, b) = (a.trim().to_ascii_lowercase(), b.trim().to_ascii_lowercase());
    a.len() >= 7 && b.len() >= 7 && (a.starts_with(&b) || b.starts_with(&a))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (sub, rest) = match args.first().map(|s| s.as_str()) {
        Some("affected") => ("affected", &args[1..]),
        Some("pack") => ("pack", &args[1..]),
        _ => ("report", &args[..]),
    };
    let o = parse(rest);
    let Some(raw_dir) = o.raw.clone() else {
        if args.is_empty() {
            // bare `vto`: show the usage (stderr, exit 2) – it is a constant, printed verbatim
            eprintln!("{USAGE}");
            exit(2)
        }
        die_usage("missing <raw> (directory with raw files or a stored map)")
    };
    // A-1 / D2.1: the root is canonical (realpath) before any comparison
    let root_arg = o.root.clone().unwrap_or_else(|| PathBuf::from("."));
    if sub == "affected" && !root_arg.is_dir() {
        die(&format!("--root {}: not a directory", root_arg.display()));
    }
    let root = paths::canonical_root(&root_arg);
    let fold = paths::is_windows_path(&root) || paths::detect_case_insensitive(&root);
    let t0 = Instant::now();
    let model = match raw::load_full(&raw_dir, &root, &o.lim, fold) {
        Ok(m) => m,
        // U-11: a missing / unreadable / empty / unsupported map is an error (exit 2), not "run all"
        Err(e) if sub == "affected" => input_error_exit(&o, &format!("cannot use the coverage map: {e}")),
        Err(e) => die(&e),
    };
    let t_load = t0.elapsed();
    if !o.quiet {
        for w in &model.warnings {
            eprintln!("vto: warning: {}", term(w));
        }
    }
    if let Some(c) = &o.expect_commit {
        if !model.git_head.as_deref().is_some_and(|g| same_commit(g, c)) {
            let msg = format!(
                "map was recorded at {}, expected {}",
                model.git_head.as_deref().unwrap_or("<no gitHead>"),
                c
            );
            if sub == "affected" {
                run_all_exit(&o, &[format!("{msg} – record a new map at that commit, or drop --expect-commit to diff from the map's own commit")]);
            }
            die(&msg);
        }
    }
    match sub {
        "affected" => {
            run_affected(&o, &model, &root);
            return;
        }
        "pack" => {
            let Some(out) = &o.out else { die("pack: --out FILE is required") };
            let s = store::pack(&model).unwrap_or_else(|e| die(&e));
            std::fs::write(out, s).unwrap_or_else(|e| die(&format!("{}: {e}", out.display())));
            if !o.quiet {
                eprintln!("vto: stored map with {} files, {} tests → {}", model.files.len(), model.units.len(), term(&out.to_string_lossy()));
            }
            return;
        }
        _ => {}
    }
    let out_dir = o.out.clone().unwrap_or_else(|| PathBuf::from("overlap-report"));
    let t1 = Instant::now();
    let an = analysis::analyze(&model, &o.an);
    let imp = imports::analyze(&model);
    let t_an = t1.elapsed();
    let t2 = Instant::now();
    let generated = report::iso_now();
    let lang = vto::i18n::Lang::resolve(o.lang.as_deref()).unwrap_or_else(|e| die(&e));
    let mo = if o.full { report::MdOpts::full(o.top) } else { report::MdOpts::compact(o.top) };
    let md = report::markdown(&model, &an, &imp, o.an.threshold, mo, &generated, lang);
    let js = report::json(&model, &an, &imp, &generated);
    std::fs::create_dir_all(&out_dir).unwrap_or_else(|e| die(&format!("{}: {e}", out_dir.display())));
    std::fs::write(out_dir.join("report.md"), &md).unwrap_or_else(|e| die(&e.to_string()));
    std::fs::write(out_dir.join("report.json"), &js).unwrap_or_else(|e| die(&e.to_string()));
    let t_rep = t2.elapsed();
    if o.timings {
        eprintln!(
            "vto: timings: load+parse {:.1} ms · analysis {:.1} ms ({}) · report {:.1} ms ({} KB md, {} KB json) · {} reps, {} candidate pairs verified",
            t_load.as_secs_f64() * 1e3,
            t_an.as_secs_f64() * 1e3,
            an.timings.iter().map(|(n, t)| format!("{n} {t:.1}")).collect::<Vec<_>>().join(", "),
            t_rep.as_secs_f64() * 1e3,
            md.len() / 1024,
            js.len() / 1024,
            an.reps,
            an.candidate_pairs
        );
        if an.common_items > 0 {
            eprintln!("vto: {} common items ignored for near-duplicate similarity", an.common_items);
        }
    }
    if an.near_truncated && !o.quiet {
        eprintln!("vto: warning: near-duplicate search hit --max-near-candidates, the list is incomplete");
    }
    if !o.quiet {
        eprintln!(
            "vto [{}]: {} tests ({} evaluated, {} excluded), {} items · identical: {} groups · contained: {} · near-identical: {} · minimal set: {}/{} · {:.1} ms (parse {:.1}, analysis {:.1}, report {:.1}) → {}",
            model.format,
            model.units.len(),
            an.clean,
            an.excluded.len(),
            an.total_items,
            an.identical.len(),
            an.subsumed.len(),
            an.near_total,
            an.keep.len(),
            an.clean - an.no_cov.len(),
            t0.elapsed().as_secs_f64() * 1e3,
            t_load.as_secs_f64() * 1e3,
            t_an.as_secs_f64() * 1e3,
            t_rep.as_secs_f64() * 1e3,
            term(&out_dir.join("report.md").to_string_lossy())
        );
    }
}

// ---------------------------------------------------------------- affected -----------

/// stdout writes that tolerate a closed pipe (`vto affected … | head`)
macro_rules! outln {
    ($($a:tt)*) => {{
        use std::io::Write;
        let _ = writeln!(std::io::stdout(), $($a)*);
    }};
}

fn has_import(src: &str, mods: &[&str]) -> bool {
    mods.iter().any(|m| {
        [format!("'{m}'"), format!("\"{m}\""), format!("'node:{m}'"), format!("\"node:{m}\"")].iter().any(|q| src.contains(q.as_str()))
    })
}

/// Does a test file import/require node's fs module (A1 fallback)?
fn uses_fs(src: &str) -> bool {
    has_import(src, &["fs", "fs/promises", "fs-extra", "graceful-fs"])
}

/// Why the recorded `fileload.reads` of a test file cannot be complete (contracts/DECISIONS.md
/// D5.8, C-M1 / S-N2a), judged from the test source when the collector did not say
/// `readsComplete`. None = no known gap.
fn reads_gap(src: &str, has_reads: bool) -> Option<&'static str> {
    if has_import(src, &["child_process", "worker_threads", "cluster", "execa", "tinyexec", "cross-spawn", "zx", "nano-spawn"]) {
        return Some("starts child processes / workers");
    }
    if !uses_fs(src) {
        return None;
    }
    if !has_reads {
        return Some("uses node:fs, no reads recorded");
    }
    if has_import(src, &["fs-extra", "graceful-fs"]) {
        return Some("uses an fs wrapper library");
    }
    // entry points older collectors do not wrap (fd / FileHandle / copy / link / watch)
    const FD: &[&str] = &["openSync", ".open(", " open(", "{ open", ", open", "readSync", "copyFile", "cpSync", ".cp(", "readlink", "realpath", "watch(", "watchFile", "readv"];
    FD.iter().any(|t| src.contains(t)).then_some("uses fd-style / copy / link fs APIs")
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}

/// Run-all sentinel on stdout in the requested format (a pipeline that ignores exit codes must
/// still run everything).
fn print_run_all(o: &Opts, reasons: &[String], error: bool) {
    if o.json {
        outln!(
            "{{\"runAll\":true,{}\"reasons\":[{}],\"tests\":[],\"files\":[],\"filters\":null}}",
            if error { "\"error\":true," } else { "" },
            reasons.iter().map(|r| json_str(r)).collect::<Vec<_>>().join(",")
        );
    } else if o.vitest && o.print0 {
        // sentinel filter "." matches every test file path: `… --print0 | xargs -0 -r npx vitest run`
        // then runs everything, while an empty selection prints nothing (and -r runs nothing)
        use std::io::Write;
        let _ = std::io::stdout().write_all(b".\0");
    } else if o.vitest {
        outln!("null"); // run all – distinct from [] (nothing selected)
    }
}

/// Prints the "run everything" result in the requested format and exits 3.
fn run_all_exit(o: &Opts, reasons: &[String]) -> ! {
    print_run_all(o, reasons, false);
    for r in reasons {
        eprintln!("vto: run all: {}", term(r));
    }
    eprintln!("vto: → run all tests (exit 3)");
    exit(3)
}

/// Unusable input of `affected` (missing / unreadable / empty / oversized map, unsupported
/// version): an ERROR, exit 2 – a typo in a CI path must be loud (U-11). stdout still carries
/// the run-all sentinel so that a pipeline which drops exit codes cannot turn the error into
/// "nothing to run".
fn input_error_exit(o: &Opts, msg: &str) -> ! {
    print_run_all(o, &[format!("error: {msg}")], true);
    eprintln!("vto: error: {}", term(msg));
    eprintln!("vto: no selection was computed (exit 2). Fix the command; until then run all tests.");
    exit(2)
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(10)]
}

fn run_affected(o: &Opts, model: &vto::model::Model, root: &str) {
    let mut reasons: Vec<String> = Vec::new();
    let mut hints: Vec<String> = Vec::new();
    let git = Git::new(root);
    // A-1: the map must describe THIS tree. Paths are root-relative; when not a single file of
    // the map exists below the root, the root (or the map) is wrong – never answer "0 tests".
    {
        let mut names: Vec<&str> = model.units.iter().map(|u| u.file.as_str()).chain(model.files.iter().map(|f| f.as_str())).collect();
        names.sort_unstable();
        names.dedup();
        // sample evenly, at most 200 stats
        let step = names.len().div_ceil(200).max(1);
        let sample: Vec<&str> = names.iter().step_by(step).copied().collect();
        let present = sample.iter().filter(|f| Path::new(&paths::join(root, f)).exists()).count();
        // one coincidental README.md / package.json must not pass for "the same project"
        if !sample.is_empty() && present * 2 < sample.len() {
            run_all_exit(
                o,
                &[format!(
                    "root mismatch: only {present} of {} sampled files of the map exist below {root}{} – pass the project root with --root",
                    sample.len(),
                    model.meta_root.as_deref().map(|m| format!(" (the map was recorded at {m})")).unwrap_or_default()
                )],
            );
        }
    }
    let map_head = model.git_head.clone();
    let (text, base_sha) = match (&o.git, &o.diff) {
        (Some(base), None) => {
            let asked = match git.resolve_commit(base) {
                Ok(s) => s,
                Err(e) => run_all_exit(o, &[format!("cannot resolve --git base: {e}")]),
            };
            // U-5: the map describes the tree at its own commit, so that commit – not the base the
            // user named – is the correct left side of the diff. Recorded failures stay selected
            // (D5.7), so nothing between the two commits is lost.
            let mut sha = asked.clone();
            if !o.allow_stale {
                match &map_head {
                    Some(g) if !same_commit(g, &asked) => match git.resolve_commit(g) {
                        Ok(gs) => {
                            hints.push(format!(
                                "the map was recorded at {} (you asked for {} = {}): using the diff {} → working tree, which is what the map can answer. Re-record the map to shorten it.",
                                short(&gs), term(base), short(&asked), short(&gs)
                            ));
                            sha = gs;
                        }
                        Err(_) => reasons.push(format!(
                            "the map was recorded at {g}, which is not a commit of this clone (shallow clone or another repository?) – fetch that commit (git fetch --depth=1 origin {g}) or record a new map"
                        )),
                    },
                    _ => {}
                }
            }
            let mut d = match git.diff_worktree(&sha) {
                Ok(d) => d,
                Err(e) => run_all_exit(o, &[format!("git diff failed: {e}")]),
            };
            // untracked files are not part of `git diff` – add them as new files
            let untracked = match git.untracked() {
                Ok(u) => u,
                Err(e) => run_all_exit(o, &[format!("git ls-files failed: {e}")]),
            };
            for f in untracked {
                if f.contains('\n') || f.contains('"') || f.contains('\\') {
                    reasons.push(format!("untracked file with a special name: {}", term(&f)));
                    continue;
                }
                d.push_str(&format!("diff --git a/{f} b/{f}\nnew file mode 100644\n--- /dev/null\n+++ b/{f}\n"));
            }
            (d, Some(sha))
        }
        (None, Some(d)) => {
            let t = if d == "-" {
                let mut s = String::new();
                std::io::Read::read_to_string(&mut std::io::stdin(), &mut s).unwrap_or_else(|e| die(&e.to_string()));
                s
            } else {
                std::fs::read_to_string(d).unwrap_or_else(|e| die(&format!("{d}: {e}")))
            };
            if let Some(b) = &o.base {
                if !git::valid_rev(b) {
                    run_all_exit(o, &[format!("invalid --base {:?}", term(b))]);
                }
            }
            (t, o.base.clone())
        }
        _ => die_usage("affected: exactly one of --git <base> or --diff <file|-> is required"),
    };
    // map provenance (F6/F7): the diff must start at the commit the map was recorded at
    if !o.allow_stale {
        match (&map_head, &base_sha) {
            (None, _) => reasons.push("the map records no gitHead – record it inside a git repository, or pass --allow-stale to accept it".into()),
            (Some(_), None) => reasons.push("diff base unknown (pass --base SHA with --diff, or --allow-stale)".into()),
            (Some(g), Some(b)) if !same_commit(g, b) && o.diff.is_some() => reasons.push(format!(
                "the map was recorded at {g}, but the diff base is {b} (stale map) – produce the diff from the map's commit: git diff -U0 --no-renames {g} | vto affected <map> --diff - --base {g}"
            )),
            _ => {}
        }
        if model.dirty && model.dirty_files.is_none() {
            reasons.push(
                "the map was recorded on a dirty working tree and does not list the modified files (meta.dirtyFiles) – commit first and record again, or record with a collector that writes meta.dirtyFiles; --allow-stale accepts the map as it is"
                    .into(),
            );
        }
    } else if !o.quiet && model.git_head.is_none() {
        eprintln!("vto: warning: map without gitHead accepted (--allow-stale)");
    }
    if model.format_version.is_none() && !o.quiet {
        eprintln!("vto: warning: raw data has no format version (old collector?)");
    }
    // diff paths are relative to the git top level → make them relative to the analysis root
    let top = git.toplevel().ok();
    let mut changes = affected::parse_diff(&text);
    let mut aff = o.aff.clone();
    let fold = |p: &str| paths::fold_key(p, model.windows);
    if let Some(top) = &top {
        if fold(top) != fold(root) {
            for c in &mut changes {
                for p in [&mut c.old, &mut c.new].into_iter().flatten() {
                    *p = paths::rel(&paths::join(top, p), root);
                }
            }
        }
    }
    for c in &mut changes {
        for p in [&mut c.old, &mut c.new].into_iter().flatten() {
            *p = paths::normalize(p); // NFC (D2.3)
        }
    }
    let idx = model.file_index();
    let recorded = |p: &str| -> Option<&str> { idx.get(&fold(p)).and_then(|&fi| model.file_hashes.get(fi)).and_then(|h| h.as_deref()) };
    let worktree = |p: &str| -> Option<Vec<u8>> { std::fs::read(paths::join(root, p)).ok() };
    let mut handled: std::collections::HashSet<String> = Default::default();
    // U-5, dirty map: every file that was modified at record time is compared by content. Equal
    // to the recorded hash ⇒ unchanged since the map was recorded (whatever git says); anything
    // else ⇒ changed without usable line information.
    if !o.allow_stale && model.dirty {
        if let Some(df) = &model.dirty_files {
            let (mut same, mut diff) = (0, 0);
            for (p, h) in df {
                let k = fold(p);
                if !handled.insert(k.clone()) {
                    continue;
                }
                let rec = h.as_deref().or_else(|| recorded(p));
                let now = worktree(p);
                changes.retain(|c| c.old.as_deref().map(&fold) != Some(k.clone()) && c.new.as_deref().map(&fold) != Some(k.clone()));
                match (rec, &now) {
                    (Some(r), Some(b)) if store::hash_matches(r, b) => same += 1,
                    _ => {
                        diff += 1;
                        aff.stale.push(p.clone());
                        changes.push(affected::FileChange { old: Some(p.clone()), new: now.is_some().then(|| p.clone()), ..Default::default() });
                    }
                }
            }
            hints.push(format!(
                "the map was recorded on a dirty working tree: {} file(s) modified at that time, {same} unchanged since, {diff} treated as changed (no line information). Commit and re-record for precise selection.",
                df.len()
            ));
        }
    }
    if !o.allow_stale {
        // stale-content check 1: base-side content of every changed file vs the recorded hash
        if let (Some(top), Some(sha)) = (&top, &base_sha) {
            if git::is_sha(sha) {
                for c in &changes {
                    let Some(old) = &c.old else { continue };
                    if handled.contains(&fold(old)) {
                        continue;
                    }
                    let Some(h) = recorded(old) else { continue };
                    let repo_path = paths::rel(&paths::join(root, old), top);
                    match git.blob(sha, &repo_path) {
                        Ok(bytes) if store::hash_matches(h, &bytes) => {}
                        _ => aff.stale.push(old.clone()),
                    }
                }
            }
        }
        // stale-content check 2 (correctness m1): files git reports as unchanged, but whose
        // working-tree content is not what the map recorded (skip-worktree / assume-unchanged,
        // git-ignored generated sources)
        let in_diff: std::collections::HashSet<String> = changes.iter().flat_map(|c| c.old.iter().chain(c.new.iter())).map(|p| fold(p)).collect();
        let mut hidden = 0;
        for (fi, h) in model.file_hashes.iter().enumerate() {
            let Some(h) = h else { continue };
            let p = &model.files[fi];
            if in_diff.contains(&fold(p)) || handled.contains(&fold(p)) {
                continue;
            }
            match worktree(p) {
                Some(b) if store::hash_matches(h, &b) => {}
                now => {
                    hidden += 1;
                    aff.stale.push(p.clone());
                    changes.push(affected::FileChange { old: Some(p.clone()), new: now.is_some().then(|| p.clone()), ..Default::default() });
                }
            }
        }
        if hidden > 0 {
            hints.push(format!("{hidden} file(s) differ from the recorded content although git reports no change (skip-worktree, ignored or generated files) → treated as changed"));
        }
    }
    // C-M1 / S-N2a: test files whose file-system inputs are not completely recorded
    {
        let fl: std::collections::HashMap<&str, &vto::model::FileLoad> = model.fileloads.iter().map(|f| (f.test_file.as_str(), f)).collect();
        let mut seen = std::collections::HashSet::new();
        for u in &model.units {
            let k = u.file_key();
            if !seen.insert(k.to_string()) {
                continue;
            }
            let f = fl.get(k);
            match f.and_then(|f| f.reads_complete) {
                Some(true) => continue,
                Some(false) => {
                    aff.fs_readers.push(k.to_string());
                    continue;
                }
                None => {}
            }
            if let Ok(src) = std::fs::read_to_string(paths::join(root, &u.file)) {
                if reads_gap(&src, f.is_some_and(|f| f.reads.is_some())).is_some() {
                    aff.fs_readers.push(k.to_string());
                }
            }
        }
    }
    let mut a = affected::affected(model, &changes, &aff);
    a.run_all.splice(0..0, reasons);
    if !o.quiet {
        for h in &hints {
            eprintln!("vto: note: {}", term(h));
        }
        for n in &a.notes {
            eprintln!("vto: {}", term(n));
        }
        for f in &a.ignored {
            eprintln!("vto: ignored {}", term(f));
        }
    }
    if !a.run_all.is_empty() {
        if !o.quiet {
            eprintln!("vto: {} of {} tests would be selected, but:", a.units.len(), model.units.len());
        }
        run_all_exit(o, &a.run_all);
    }
    let filters = affected::vitest_filters(model, &a);
    if o.json {
        let tests: Vec<String> = a
            .units
            .iter()
            .map(|&u| {
                let un = &model.units[u];
                format!(
                    "{{\"id\":{},\"file\":{},\"line\":{},\"name\":{}}}",
                    json_str(&un.id),
                    json_str(&un.file),
                    un.line.map_or("null".into(), |l| l.to_string()),
                    json_str(&un.names[0])
                )
            })
            .collect();
        // `files` is THE selection: a selected file runs completely, including tests the map does
        // not know (`known:false` = new / renamed test file). `tests` lists the recorded tests.
        let files: Vec<String> =
            a.files.iter().map(|f| format!("{{\"file\":{},\"whole\":{},\"known\":{}}}", json_str(&f.path), f.whole, f.known)).collect();
        outln!(
            "{{\"runAll\":false,\"reasons\":[],\"tests\":[{}],\"files\":[{}],\"filters\":{}}}",
            tests.join(","),
            files.join(","),
            serde_json::to_string(&filters).unwrap()
        );
    } else if o.vitest {
        // F17: never a shell-word string – JSON array or NUL-separated; "./" keeps a file named
        // "--x.test.ts" from being parsed as an option
        if o.print0 {
            use std::io::Write;
            let mut so = std::io::stdout().lock();
            for x in &filters {
                let _ = so.write_all(x.as_bytes());
                let _ = so.write_all(b"\0");
            }
        } else {
            outln!("{}", serde_json::to_string(&filters).unwrap());
        }
    } else {
        for &u in &a.units {
            outln!("{}", term(&model.units[u].id));
        }
        for f in a.files.iter().filter(|f| !f.known) {
            outln!("{} > (new test file, every test)", term(&f.path));
        }
    }
    if !o.quiet {
        eprintln!(
            "vto: {} test file(s) selected ({} of {} recorded tests) for {} changed file(s)",
            a.files.len(),
            a.units.len(),
            model.units.len(),
            changes.len()
        );
    }
}
