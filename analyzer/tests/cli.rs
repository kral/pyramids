//! report.md language selection (English default, `--lang cs` / `VTO_LANG=cs`).
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_vto");

fn report(args: &[&str], env: Option<(&str, &str)>) -> (Option<i32>, String, String) {
    let out = std::env::temp_dir().join(format!("vto-cli-{}-{}", std::process::id(), args.join("_").replace('-', "")));
    let mut c = Command::new(BIN);
    c.arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/v2"))
        .args(["--root", "/home/claude/demo", "--quiet", "--out"])
        .arg(&out)
        .args(args)
        .env_remove("VTO_LANG");
    if let Some((k, v)) = env {
        c.env(k, v);
    }
    let o = c.output().unwrap();
    let md = std::fs::read_to_string(out.join("report.md")).unwrap_or_default();
    let js = std::fs::read_to_string(out.join("report.json")).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&out);
    (o.status.code(), md, js)
}

fn strip_time(js: &str) -> String {
    js.lines().filter(|l| !l.contains("generatedAt")).collect::<Vec<_>>().join("\n")
}

#[test]
fn english_by_default_czech_on_request() {
    let (c, en, js_en) = report(&[], None);
    assert_eq!(c, Some(0));
    assert!(en.starts_with("# Vitest – overlapping tests report"));
    for h in ["## Summary", "## Candidates for review", "## Identical coverage", "## Minimal test set", "## All tests"] {
        assert!(en.contains(h), "missing {h}");
    }
    assert!(!en.contains("Souhrn"));
    let (_, cs, js_cs) = report(&["--lang", "cs"], None);
    assert!(cs.starts_with("# Vitest – report překrývajících se testů"));
    for h in ["## Souhrn", "## Kandidáti k revizi", "## Shodné pokrytí", "## Minimální sada testů", "## Všechny testy"] {
        assert!(cs.contains(h), "missing {h}");
    }
    let (_, cs_env, _) = report(&[], Some(("VTO_LANG", "cs")));
    assert!(cs_env.contains("## Souhrn"));
    // --lang wins over VTO_LANG
    let (_, en2, _) = report(&["--lang", "en"], Some(("VTO_LANG", "cs")));
    assert!(en2.contains("## Summary"));
    // report.json is language-independent
    assert_eq!(strip_time(&js_en), strip_time(&js_cs));
    let (c, _, _) = report(&["--lang", "de"], None);
    assert_eq!(c, Some(2));
}
