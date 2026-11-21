//! Stored coverage map (`vto pack`): one self-contained JSONL file with format version,
//! root-relative paths and per-file content hashes (FORMAT.md, v2 addendum B). It is read back
//! by the normal raw loader (a file instead of a directory).

use crate::model::Model;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fmt::Write;

pub fn sha256_hex(bytes: &[u8]) -> String {
    let d = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in d {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// THE content hash (contracts/DECISIONS.md D1): SHA-256 of the bytes after removing one leading
/// UTF-8 BOM and replacing every CR LF by LF.
pub fn content_hash(bytes: &[u8]) -> String {
    let b = bytes.strip_prefix(&[0xef, 0xbb, 0xbf][..]).unwrap_or(bytes);
    if !b.windows(2).any(|w| w == b"\r\n") {
        return sha256_hex(b);
    }
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\r' && b.get(i + 1) == Some(&b'\n') {
            i += 1;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    sha256_hex(&out)
}

/// Does `bytes` have the recorded hash? Accepts the D1 hash and, for maps written before D1,
/// the plain SHA-256 of the bytes (both prove equal content).
pub fn hash_matches(recorded: &str, bytes: &[u8]) -> bool {
    let r = recorded.trim().to_ascii_lowercase();
    r.len() == 64 && (content_hash(bytes) == r || sha256_hex(bytes) == r)
}

/// Serialises a v2 model. Paths are already root-relative display paths in the model.
pub fn pack(model: &Model) -> Result<String, String> {
    if model.format != "v2" {
        return Err("only v2 data can be packed".into());
    }
    let mut out = String::new();
    let line = |out: &mut String, v: serde_json::Value| {
        out.push_str(&v.to_string());
        out.push('\n');
    };
    line(
        &mut out,
        json!({"t":"meta","version":crate::raw::RAW_VERSION,"stored":true,"pathBase":"root",
               "gitHead":model.git_head,"dirty":model.dirty,"setupFiles":model.setup_files}),
    );
    // optional meta fields go into a second meta record only when present (keeps old readers happy)
    if model.dirty_files.is_some() || !model.test_files.is_empty() {
        let mut m = json!({"t":"meta","version":crate::raw::RAW_VERSION});
        if let Some(d) = &model.dirty_files {
            m["dirtyFiles"] = d.iter().map(|(p, h)| json!({"path": p, "sha256": h})).collect();
        }
        if !model.test_files.is_empty() {
            m["testFiles"] = json!(model.test_files);
        }
        line(&mut out, m);
    }
    // items per file in id order → local block ids
    let nf = model.files.len();
    let mut local = vec![0u32; model.items.len()];
    let mut blocks: Vec<Vec<[u32; 2]>> = vec![Vec::new(); nf];
    for (i, it) in model.items.iter().enumerate() {
        let b = &mut blocks[it.file as usize];
        local[i] = b.len() as u32;
        b.push([it.span.0, it.span.1]);
    }
    for f in 0..nf {
        if blocks[f].is_empty() && model.file_hashes.get(f).and_then(|h| h.as_ref()).is_none() {
            continue;
        }
        let bl: Vec<serde_json::Value> = blocks[f].iter().map(|b| json!([b[0], 0, b[1], 0, "b"])).collect();
        let mut rec = json!({"t":"file","file":model.files[f],"blocks":bl});
        if let Some(Some(h)) = model.file_hashes.get(f) {
            rec["sha256"] = json!(h);
        }
        line(&mut out, rec);
    }
    let hits = |items: &[u32]| -> serde_json::Value {
        let mut m: std::collections::BTreeMap<&str, Vec<u32>> = Default::default();
        for &i in items {
            m.entry(model.files[model.items[i as usize].file as usize].as_str()).or_default().push(local[i as usize]);
        }
        json!(m)
    };
    for u in &model.units {
        let mut rec = json!({"t":"test","file":u.file,"name":u.names[0],"line":u.line,
            "state": if u.failed { "fail" } else if u.skipped { "skip" } else { "pass" },
            "hits": hits(&u.items)});
        for (k, v) in [("tainted", u.tainted), ("leaky", u.leaky)] {
            if v {
                rec[k] = json!(true);
            }
        }
        if u.retried {
            rec["retryCount"] = json!(1);
        }
        if let Some(d) = u.duration_ms {
            rec["durationMs"] = json!(d);
        }
        if let Some(a) = u.assertions {
            rec["assertions"] = json!(a);
        }
        if let Some(h) = &u.assert_hash {
            rec["assertHash"] = json!(h);
        }
        if let Some(h) = &u.dom_hash {
            rec["domHash"] = json!(h);
        }
        line(&mut out, rec);
    }
    for (k, fl) in model.fileloads.iter().enumerate() {
        let modules: Vec<serde_json::Value> = fl
            .modules
            .iter()
            .map(|&m| match fl.load_ms.iter().find(|x| x.0 == m) {
                Some(&(_, ms)) => json!({"file": model.files[m as usize], "loadMs": ms}),
                None => json!(model.files[m as usize]),
            })
            .collect();
        // import-time hits are a global union in the model; store them once
        let h = if k == 0 { hits(&model.import_items) } else { json!({}) };
        let mut rec = json!({"t":"fileload","testFile":fl.display,"hits":h,"modules":modules});
        if let Some(r) = &fl.reads {
            rec["reads"] = json!(r);
        }
        if let Some(c) = fl.reads_complete {
            rec["readsComplete"] = json!(c);
        }
        if fl.error {
            rec["error"] = json!(true);
        }
        line(&mut out, rec);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha() {
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    /// contracts/fixtures/hash-vectors.json pins D1 for every implementation.
    #[test]
    fn hash_vectors() {
        use base64::Engine;
        let j: serde_json::Value = serde_json::from_str(include_str!("../../contracts/fixtures/hash-vectors.json")).unwrap();
        let v = j["vectors"].as_array().unwrap();
        assert!(v.len() >= 8);
        for c in v {
            let bytes = base64::engine::general_purpose::STANDARD.decode(c["base64"].as_str().unwrap()).unwrap();
            assert_eq!(content_hash(&bytes), c["contentHash"].as_str().unwrap(), "{}", c["name"]);
            assert!(hash_matches(c["contentHash"].as_str().unwrap(), &bytes));
            assert!(hash_matches(&sha256_hex(&bytes), &bytes), "legacy raw-byte hash accepted");
        }
        // CRLF and BOM variants of one text are one content
        assert_eq!(content_hash(b"\xef\xbb\xbfa\r\nb\r\n"), content_hash(b"a\nb\n"));
        assert_ne!(content_hash(b"a\rb"), content_hash(b"ab"));
        assert!(!hash_matches(&content_hash(b"a\n"), b"b\n"));
    }

    #[test]
    fn roundtrip_fixture() {
        let dir = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/v2"));
        let m = crate::raw::load(dir, "/home/claude/demo").unwrap();
        let packed = pack(&m).unwrap();
        let tmp = std::env::temp_dir().join(format!("vto-pack-{}.jsonl", std::process::id()));
        std::fs::write(&tmp, &packed).unwrap();
        let m2 = crate::raw::load(&tmp, "/somewhere/else").unwrap();
        std::fs::remove_file(&tmp).ok();
        assert_eq!(m2.files, m.files);
        assert_eq!(m2.units.len(), m.units.len());
        for (a, b) in m.units.iter().zip(&m2.units) {
            assert_eq!(a.id, b.id);
            assert_eq!(a.items, b.items);
        }
        assert_eq!(m2.git_head, m.git_head);
        assert_eq!(m2.format_version, Some(crate::raw::RAW_VERSION));
    }
}
