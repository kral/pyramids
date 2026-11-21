//! Contract tests (A-7): `contracts/raw-2.schema.json` and `contracts/map-2.schema.json` are the
//! single source of truth for the raw format and the stored map. This suite
//! - validates the golden fixtures (`contracts/fixtures/raw/valid`, the analyzer's own fixtures)
//!   against the schema and loads them with the real reader without integrity problems,
//! - checks that every record in `contracts/fixtures/raw/invalid/cases.json` is rejected by the
//!   schema and handled by the reader as the case says,
//! - pins the stored-map form: `vto pack` of the lab map equals `contracts/fixtures/map/lab.map.jsonl`
//!   byte for byte, validates against the map schema and obeys the per-file rules.
//!
//! The validator below implements the JSON Schema 2020-12 subset the two schemas use (and fails
//! on any keyword it does not know), so no schema library is needed to build the analyzer. JS
//! packages validate the same files with ajv (`ajv/dist/2020`).

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_vto");

fn contracts() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../contracts")
}

fn load_json(p: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

// ---------------------------------------------------------------- mini JSON Schema validator

const ANNOTATIONS: &[&str] = &["$schema", "$id", "$defs", "$comment", "title", "description", "deprecated", "x-since", "examples", "default"];

fn type_ok(t: &str, v: &Value) -> bool {
    match t {
        "string" => v.is_string(),
        "integer" => v.as_i64().is_some() || v.as_u64().is_some() || v.as_f64().is_some_and(|f| f.fract() == 0.0),
        "number" => v.is_number(),
        "boolean" => v.is_boolean(),
        "null" => v.is_null(),
        "array" => v.is_array(),
        "object" => v.is_object(),
        other => panic!("schema: unknown type {other}"),
    }
}

/// Ok(()) or the path + reason of the first violation.
fn validate(root: &Value, schema: &Value, v: &Value, at: &str) -> Result<(), String> {
    let s = match schema {
        Value::Bool(true) => return Ok(()),
        Value::Bool(false) => return Err(format!("{at}: not allowed")),
        Value::Object(o) => o,
        _ => panic!("schema must be an object or boolean"),
    };
    for (k, sv) in s {
        match k.as_str() {
            "$ref" => {
                let r = sv.as_str().unwrap();
                let target = r.strip_prefix("#/").map(|p| p.split('/').fold(root, |n, seg| &n[seg])).unwrap_or_else(|| panic!("schema: unsupported $ref {r}"));
                assert!(!target.is_null(), "schema: dangling $ref {r}");
                validate(root, target, v, at)?;
            }
            "type" => {
                let ok = match sv {
                    Value::String(t) => type_ok(t, v),
                    Value::Array(ts) => ts.iter().any(|t| type_ok(t.as_str().unwrap(), v)),
                    _ => panic!("schema: bad type"),
                };
                if !ok {
                    return Err(format!("{at}: expected type {sv}"));
                }
            }
            "const" => {
                if v != sv {
                    return Err(format!("{at}: expected {sv}"));
                }
            }
            "enum" => {
                if !sv.as_array().unwrap().contains(v) {
                    return Err(format!("{at}: not one of {sv}"));
                }
            }
            "minimum" => {
                if v.as_f64().is_some_and(|x| x < sv.as_f64().unwrap()) {
                    return Err(format!("{at}: below minimum {sv}"));
                }
            }
            "maximum" => {
                if v.as_f64().is_some_and(|x| x > sv.as_f64().unwrap()) {
                    return Err(format!("{at}: above maximum {sv}"));
                }
            }
            "minLength" | "maxLength" => {
                if let Some(x) = v.as_str() {
                    let n = x.chars().count() as u64;
                    let lim = sv.as_u64().unwrap();
                    if (k == "minLength" && n < lim) || (k == "maxLength" && n > lim) {
                        return Err(format!("{at}: {k} {lim}"));
                    }
                }
            }
            "pattern" => {
                if let Some(x) = v.as_str() {
                    if !regex::Regex::new(sv.as_str().unwrap()).unwrap().is_match(x) {
                        return Err(format!("{at}: does not match {sv}"));
                    }
                }
            }
            "minItems" | "maxItems" => {
                if let Some(a) = v.as_array() {
                    let lim = sv.as_u64().unwrap() as usize;
                    if (k == "minItems" && a.len() < lim) || (k == "maxItems" && a.len() > lim) {
                        return Err(format!("{at}: {k} {lim}"));
                    }
                }
            }
            "prefixItems" => {
                if let Some(a) = v.as_array() {
                    for (i, (x, ps)) in a.iter().zip(sv.as_array().unwrap()).enumerate() {
                        validate(root, ps, x, &format!("{at}[{i}]"))?;
                    }
                }
            }
            "items" => {
                if let Some(a) = v.as_array() {
                    let skip = s.get("prefixItems").and_then(|p| p.as_array()).map_or(0, |p| p.len());
                    for (i, x) in a.iter().enumerate().skip(skip) {
                        validate(root, sv, x, &format!("{at}[{i}]"))?;
                    }
                }
            }
            "required" => {
                if let Some(o) = v.as_object() {
                    for r in sv.as_array().unwrap() {
                        if !o.contains_key(r.as_str().unwrap()) {
                            return Err(format!("{at}: missing {r}"));
                        }
                    }
                }
            }
            "properties" => {
                if let Some(o) = v.as_object() {
                    for (pk, ps) in sv.as_object().unwrap() {
                        if let Some(x) = o.get(pk) {
                            validate(root, ps, x, &format!("{at}.{pk}"))?;
                        }
                    }
                }
            }
            "additionalProperties" => {
                if let Some(o) = v.as_object() {
                    let known = s.get("properties").and_then(|p| p.as_object());
                    for (pk, x) in o {
                        if known.is_some_and(|p| p.contains_key(pk)) {
                            continue;
                        }
                        validate(root, sv, x, &format!("{at}.{pk}")).map_err(|e| if sv == &Value::Bool(false) { format!("{at}: unknown field {pk:?}") } else { e })?;
                    }
                }
            }
            "anyOf" => {
                let errs: Vec<String> = sv.as_array().unwrap().iter().filter_map(|b| validate(root, b, v, at).err()).collect();
                if errs.len() == sv.as_array().unwrap().len() {
                    return Err(format!("{at}: no anyOf branch matches ({})", errs.join(" | ")));
                }
            }
            "oneOf" => {
                let res: Vec<Result<(), String>> = sv.as_array().unwrap().iter().map(|b| validate(root, b, v, at)).collect();
                let n = res.iter().filter(|r| r.is_ok()).count();
                if n != 1 {
                    // report the error of the branch whose `t` matches, if any
                    let best = res.iter().filter_map(|r| r.as_ref().err()).find(|e| !e.ends_with(".t: expected \"meta\"") && !e.contains(".t: expected") && !e.contains(".t: not one of"));
                    return Err(format!("{at}: {n} oneOf branches match{}", best.map(|e| format!(" – {e}")).unwrap_or_default()));
                }
            }
            "not" => {
                if validate(root, sv, v, at).is_ok() {
                    return Err(format!("{at}: matches a forbidden form"));
                }
            }
            k if ANNOTATIONS.contains(&k) => {}
            other => panic!("schema keyword {other:?} is not supported by the contract test – extend the validator"),
        }
    }
    Ok(())
}

fn check_lines(schema: &Value, file: &Path) -> Vec<Value> {
    let text = std::fs::read_to_string(file).unwrap();
    let mut out = Vec::new();
    for (i, l) in text.lines().enumerate().filter(|(_, l)| !l.trim().is_empty()) {
        let v: Value = serde_json::from_str(l).unwrap_or_else(|e| panic!("{}:{}: {e}", file.display(), i + 1));
        if let Err(e) = validate(schema, schema, &v, "$") {
            panic!("{}:{}: {e}\n  {l}", file.display(), i + 1);
        }
        out.push(v);
    }
    assert!(!out.is_empty(), "{}: empty", file.display());
    out
}

fn jsonl_files(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir).unwrap().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "jsonl")).collect();
    v.sort();
    v
}

// ---------------------------------------------------------------- tests

#[test]
fn schemas_are_well_formed() {
    for f in ["raw-2.schema.json", "map-2.schema.json"] {
        let s = load_json(&contracts().join(f));
        assert_eq!(s["$schema"], "https://json-schema.org/draft/2020-12/schema");
        // exercising every branch with a harmless value panics on unsupported keywords / bad $refs
        for d in s["$defs"].as_object().unwrap().values() {
            for probe in [Value::Null, serde_json::json!({}), serde_json::json!([]), serde_json::json!("x"), serde_json::json!(1)] {
                let _ = validate(&s, d, &probe, "$");
            }
        }
    }
}

#[test]
fn golden_raw_fixtures_validate_and_load() {
    let schema = load_json(&contracts().join("raw-2.schema.json"));
    let valid = contracts().join("fixtures/raw/valid");
    let files = jsonl_files(&valid);
    assert!(files.len() >= 3, "golden fixtures missing");
    for f in &files {
        check_lines(&schema, f);
        // the real reader: no invalid record, no integrity problem, no warning except those a
        // fixture is about
        let m = vto::raw::load(f, "/work/project").unwrap_or_else(|e| panic!("{}: {e}", f.display()));
        assert!(m.integrity.is_empty(), "{}: {:?}", f.display(), m.integrity);
        assert!(!m.warnings.iter().any(|w| w.contains("invalid record")), "{}: {:?}", f.display(), m.warnings);
        assert!(!m.units.is_empty() && !m.files.is_empty());
    }
    // the analyzer's own v2 fixtures are valid raw data too (v1 fixtures are V8 records: `script`/`cov`)
    // (their meta record predates `meta.version`, which readers still accept and the schema does not)
    for f in jsonl_files(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/v2")) {
        for l in std::fs::read_to_string(&f).unwrap().lines().filter(|l| !l.trim().is_empty() && !l.contains("\"t\": \"meta\"") && !l.contains("\"t\":\"meta\"")) {
            let v: Value = serde_json::from_str(l).unwrap();
            validate(&schema, &schema, &v, "$").unwrap_or_else(|e| panic!("{}: {e}", f.display()));
        }
    }
}

/// What the reader extracts from the "all fields" fixture – one assertion per 2.2 field, so a
/// renamed field cannot silently turn into "not recorded".
#[test]
fn reader_understands_every_2_2_field() {
    let f = contracts().join("fixtures/raw/valid/collector-2.2-all-fields.jsonl");
    let m = vto::raw::load(&f, "/work/project").unwrap();
    assert_eq!(m.format_version, Some(2));
    assert_eq!(m.git_head.as_deref(), Some("2eab83b656bce2a0c08fc16f87572bcc09a587de"));
    assert!(m.dirty);
    assert_eq!(m.meta_root.as_deref(), Some("/work/project"));
    let df = m.dirty_files.as_ref().unwrap();
    assert_eq!(df.len(), 3);
    assert_eq!(df[0].0, "src/price.ts");
    assert!(df[0].1.is_some() && df[1].1.is_none() && df[2] == ("notes.txt".to_string(), None));
    assert_eq!(m.test_files, vec!["test/all-skipped.test.ts", "test/broken.test.ts", "test/price.test.ts"]);
    assert_eq!(m.setup_files, vec!["test/setup.ts"]);
    assert!(m.files.contains(&"src/price.ts".to_string()) && m.files.contains(&"../shared/outside.ts".to_string()));
    let fi = m.files.iter().position(|f| f == "src/price.ts").unwrap();
    assert_eq!(m.file_hashes[fi].as_deref().map(|h| h.len()), Some(64));
    let unit = |n: &str| m.units.iter().find(|u| u.names[0] == n).unwrap_or_else(|| panic!("{n}"));
    assert!(unit("price > flaky").failed && unit("price > flaky").tainted && unit("price > flaky").leaky && unit("price > flaky").retried);
    assert!(unit("price > only in CI").skipped && unit("price > later").skipped);
    assert_eq!(unit("price > basic").assert_hash.as_deref(), Some("a1"));
    assert_eq!(unit("price > basic").items.len(), 2);
    let fl = |t: &str| m.fileloads.iter().find(|f| f.display == t).unwrap();
    let p = fl("test/price.test.ts");
    assert_eq!(p.reads_complete, Some(true));
    assert_eq!(p.reads.as_ref().unwrap(), &vec!["docs/api.md".to_string(), "src".into(), "test/__snapshots__/price.test.ts.snap".into()]);
    assert_eq!(p.modules.len(), 3);
    assert_eq!(p.load_ms.len(), 2);
    assert_eq!(fl("test/all-skipped.test.ts").reads_complete, Some(false));
    assert!(fl("test/broken.test.ts").error && !p.error);
    assert_eq!(m.import_items.len(), 1);
}

#[test]
fn invalid_records_are_rejected() {
    let schema = load_json(&contracts().join("raw-2.schema.json"));
    let cases = load_json(&contracts().join("fixtures/raw/invalid/cases.json"));
    let base: Vec<String> = cases["base"].as_array().unwrap().iter().map(|r| r.to_string()).collect();
    for r in cases["base"].as_array().unwrap() {
        validate(&schema, &schema, r, "$").unwrap();
    }
    let dir = std::env::temp_dir().join(format!("vto-contract-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let list = cases["cases"].as_array().unwrap();
    assert!(list.len() >= 15);
    for c in list {
        let name = c["name"].as_str().unwrap();
        assert!(validate(&schema, &schema, &c["record"], "$").is_err(), "schema accepts invalid record: {name}");
        let f = dir.join("w-case.jsonl");
        std::fs::write(&f, format!("{}\n{}\n", base.join("\n"), c["record"])).unwrap();
        let res = vto::raw::load(&f, "/work/project");
        match c["reader"].as_str().unwrap() {
            "error" => assert!(res.is_err(), "{name}: reader must refuse"),
            "invalid-record" => {
                let m = res.unwrap_or_else(|e| panic!("{name}: {e}"));
                assert!(m.integrity.iter().any(|x| x.contains("invalid raw records")), "{name}: {:?}", m.integrity);
            }
            "integrity" => assert!(!res.unwrap_or_else(|e| panic!("{name}: {e}")).integrity.is_empty(), "{name}"),
            "schema" => {
                res.unwrap_or_else(|e| panic!("{name}: the tolerant reader must not fail: {e}"));
            }
            other => panic!("{name}: unknown reader expectation {other}"),
        }
    }
    std::fs::remove_dir_all(&dir).ok();
}

/// The stored map is ONE form with a golden file: `vto pack` output is byte-stable.
/// Regenerate after an intended format change with `VTO_UPDATE_GOLDEN=1 cargo test --test contracts`.
#[test]
fn stored_map_golden() {
    let schema = load_json(&contracts().join("map-2.schema.json"));
    let golden = contracts().join("fixtures/map/lab.map.jsonl");
    let out = std::env::temp_dir().join(format!("vto-contract-map-{}.jsonl", std::process::id()));
    let o = Command::new(BIN)
        .arg("pack")
        .arg(contracts().join("fixtures/raw/valid/collector-2.1-lab.jsonl"))
        .args(["--quiet", "--root", "/", "--out"])
        .arg(&out)
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let packed = std::fs::read_to_string(&out).unwrap();
    if std::env::var_os("VTO_UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(golden.parent().unwrap()).unwrap();
        std::fs::write(&golden, &packed).unwrap();
    }
    assert_eq!(packed, std::fs::read_to_string(&golden).unwrap_or_default(), "stored-map format changed: update the schema, FORMAT.md and the golden file together");
    let recs = check_lines(&schema, &golden);
    // per-file rules (map-2.schema.json description)
    assert_eq!((recs[0]["t"].as_str(), recs[0]["stored"].as_bool(), recs[0]["pathBase"].as_str(), recs[0]["version"].as_u64()), (Some("meta"), Some(true), Some("root"), Some(2)));
    let mut blocks: std::collections::HashMap<String, usize> = Default::default();
    let mut tests = std::collections::HashSet::new();
    let mut loads = std::collections::HashSet::new();
    let mut import_hit_records = 0;
    for r in &recs {
        match r["t"].as_str().unwrap() {
            "file" => {
                blocks.insert(r["file"].as_str().unwrap().into(), r["blocks"].as_array().unwrap().len());
            }
            t @ ("test" | "fileload") => {
                for (f, ids) in r["hits"].as_object().unwrap() {
                    let n = *blocks.get(f).unwrap_or_else(|| panic!("hit on {f} before its file record"));
                    assert!(ids.as_array().unwrap().iter().all(|i| (i.as_u64().unwrap() as usize) < n), "hit id out of range in {f}");
                }
                if t == "test" {
                    assert!(tests.insert((r["file"].to_string(), r["name"].to_string(), r["line"].to_string())), "duplicate test record {r}");
                } else {
                    assert!(loads.insert(r["testFile"].to_string()), "duplicate fileload {r}");
                    import_hit_records += usize::from(!r["hits"].as_object().unwrap().is_empty());
                }
            }
            _ => {}
        }
    }
    assert!(import_hit_records <= 1);
    assert!(packed.contains("\"reads\":["), "stored map must keep fileload.reads");
    // round trip: the stored map loads to the same model as the raw data
    let a = vto::raw::load(&contracts().join("fixtures/raw/valid/collector-2.1-lab.jsonl"), "/").unwrap();
    let b = vto::raw::load(&golden, "/").unwrap();
    assert!(b.integrity.is_empty(), "{:?}", b.integrity);
    assert_eq!(a.files, b.files);
    assert_eq!(a.file_hashes, b.file_hashes);
    assert_eq!(a.git_head, b.git_head);
    assert_eq!(a.units.len(), b.units.len());
    for (x, y) in a.units.iter().zip(&b.units) {
        assert_eq!((&x.id, &x.items, x.failed, x.skipped), (&y.id, &y.items, y.failed, y.skipped));
    }
    assert_eq!(a.import_items, b.import_items);
    assert_eq!(a.fileloads.len(), b.fileloads.len());
    for x in &a.fileloads {
        let y = b.fileloads.iter().find(|f| f.test_file == x.test_file).unwrap();
        assert_eq!((&x.modules, &x.reads, x.reads_complete, x.error), (&y.modules, &y.reads, y.reads_complete, y.error), "{}", x.display);
    }
    std::fs::remove_file(&out).ok();
}

/// The 2.2 optional fields survive `vto pack` (dirtyFiles, testFiles, readsComplete, error).
#[test]
fn stored_map_keeps_2_2_fields() {
    let schema = load_json(&contracts().join("map-2.schema.json"));
    let src = contracts().join("fixtures/raw/valid/collector-2.2-all-fields.jsonl");
    let out = std::env::temp_dir().join(format!("vto-contract-map22-{}.jsonl", std::process::id()));
    let o = Command::new(BIN).arg("pack").arg(&src).args(["--quiet", "--root", "/work/project", "--out"]).arg(&out).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    // the fixture has a module outside the root, which a portable map cannot hold by the schema;
    // everything else must validate
    let text = std::fs::read_to_string(&out).unwrap();
    for l in text.lines().filter(|l| !l.contains("../shared/outside.ts")) {
        let v: Value = serde_json::from_str(l).unwrap();
        validate(&schema, &schema, &v, "$").unwrap_or_else(|e| panic!("{e}\n  {l}"));
    }
    let a = vto::raw::load(&src, "/work/project").unwrap();
    let b = vto::raw::load(&out, "/work/project").unwrap();
    assert_eq!(a.dirty_files, b.dirty_files);
    assert_eq!(a.test_files, b.test_files);
    assert_eq!((a.dirty, a.setup_files.clone()), (b.dirty, b.setup_files.clone()));
    for x in &a.fileloads {
        let y = b.fileloads.iter().find(|f| f.test_file == x.test_file).unwrap();
        assert_eq!((x.reads_complete, x.error, &x.reads), (y.reads_complete, y.error, &y.reads));
    }
    std::fs::remove_file(&out).ok();
}
