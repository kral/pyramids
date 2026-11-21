//! Path helpers: file:// URLs, normalisation, relative paths. Works with '/' separators;
//! Windows paths are normalised to forward slashes (drive letters kept).

pub fn url_to_path(url: &str) -> String {
    let p = match url.strip_prefix("file://") {
        Some(rest) => {
            let dec = String::from_utf8_lossy(&crate::sourcemap::percent_decode(rest)).into_owned();
            // file:///C:/x → C:/x
            let b = dec.as_bytes();
            if b.len() > 2 && b[0] == b'/' && b[2] == b':' && b[1].is_ascii_alphabetic() {
                dec[1..].to_string()
            } else {
                dec
            }
        }
        None => url.to_string(),
    };
    normalize(&p)
}

/// Unicode NFC (contracts/DECISIONS.md D2.3); ASCII fast path.
pub fn nfc(s: &str) -> std::borrow::Cow<'_, str> {
    use unicode_normalization::{is_nfc_quick, IsNormalized, UnicodeNormalization};
    if s.is_ascii() || is_nfc_quick(s.chars()) == IsNormalized::Yes {
        std::borrow::Cow::Borrowed(s)
    } else {
        std::borrow::Cow::Owned(s.nfc().collect())
    }
}

/// '\' → '/', resolves "." and "..", removes duplicate slashes, NFC. A UNC prefix is kept as
/// `//server/share`.
pub fn normalize(p: &str) -> String {
    let p = nfc(p).replace('\\', "/");
    let unc = p.starts_with("//") && !p.starts_with("///");
    let abs = p.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for c in p.split('/') {
        match c {
            "" | "." => {}
            ".." => {
                if matches!(parts.last(), Some(l) if *l != "..") {
                    parts.pop();
                } else if !abs {
                    parts.push("..");
                }
            }
            c => parts.push(c),
        }
    }
    let mut j = parts.join("/");
    // canonical upper-case drive letter
    if j.len() >= 2 && j.as_bytes()[1] == b':' && j.as_bytes()[0].is_ascii_lowercase() {
        j = format!("{}{}", j[..1].to_ascii_uppercase(), &j[1..]);
    }
    if unc {
        format!("//{j}")
    } else if abs {
        format!("/{j}")
    } else {
        j
    }
}

/// Canonical root (DECISIONS D2.1): realpath, `/` separators, no `\\?\` prefix, upper-case
/// drive letter, NFC. Falls back to the normalised absolute path when the directory does not
/// exist.
pub fn canonical_root(p: &std::path::Path) -> String {
    let abs = if p.is_absolute() || is_abs(&p.to_string_lossy()) {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    };
    match std::fs::canonicalize(&abs) {
        Ok(c) => {
            let s = c.to_string_lossy().into_owned();
            let s = match s.strip_prefix(r"\\?\UNC\") {
                Some(rest) => format!(r"\\{rest}"),
                None => s.strip_prefix(r"\\?\").map(|x| x.to_string()).unwrap_or(s),
            };
            normalize(&s)
        }
        Err(_) => normalize(&abs.to_string_lossy()),
    }
}

/// Probes whether the file system holding `root` is case-insensitive (DECISIONS D2.4): flips
/// the case of an existing name and checks that it resolves to the same file. Undecidable ⇒
/// `false` on POSIX paths, `true` for drive-letter / UNC roots.
pub fn detect_case_insensitive(root: &str) -> bool {
    let default = is_windows_path(root) || root.starts_with("//");
    let flip = |n: &str| -> Option<String> {
        let f: String = n.chars().map(|c| if c.is_lowercase() { c.to_uppercase().next().unwrap_or(c) } else if c.is_uppercase() { c.to_lowercase().next().unwrap_or(c) } else { c }).collect();
        (f != n).then_some(f)
    };
    let same = |a: &std::path::Path, b: &std::path::Path| -> Option<bool> {
        let ma = std::fs::metadata(a).ok()?;
        match std::fs::metadata(b) {
            Err(_) => Some(false),
            Ok(_mb) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    Some(ma.dev() == _mb.dev() && ma.ino() == _mb.ino())
                }
                #[cfg(not(unix))]
                {
                    let _ = ma;
                    Some(true)
                }
            }
        }
    };
    let rp = std::path::Path::new(root);
    // the root directory itself, then package.json, then the first entry with a letter
    if let (Some(name), Some(parent)) = (rp.file_name().and_then(|n| n.to_str()), rp.parent()) {
        if let Some(f) = flip(name) {
            if let Some(r) = same(rp, &parent.join(f)) {
                return r;
            }
        }
    }
    let mut names: Vec<String> = vec!["package.json".into()];
    if let Ok(rd) = std::fs::read_dir(rp) {
        names.extend(rd.flatten().take(64).filter_map(|e| e.file_name().into_string().ok()));
    }
    for n in names {
        if let Some(f) = flip(&n) {
            // a sibling that really has the flipped name would fool the probe: require that it
            // is not listed as a separate entry (same inode check covers POSIX)
            if let Some(r) = same(&rp.join(&n), &rp.join(f)) {
                return r;
            }
        }
    }
    default
}

/// Windows (drive-letter) paths are case-insensitive: key for interning / comparisons.
pub fn is_windows_path(p: &str) -> bool {
    let b = p.as_bytes();
    b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic()
}

/// Identity key of a normalised path: case-folded when the path (or the root) is a Windows path.
pub fn fold_key(p: &str, windows: bool) -> String {
    let p = nfc(p);
    if windows || is_windows_path(&p) {
        p.to_lowercase()
    } else {
        p.into_owned()
    }
}

pub fn is_abs(p: &str) -> bool {
    let b = p.as_bytes();
    p.starts_with('/') || p.starts_with('\\') || (b.len() > 2 && b[1] == b':' && b[0].is_ascii_alphabetic())
}

pub fn dirname(p: &str) -> &str {
    match p.rfind('/') {
        Some(0) => "/",
        Some(i) => &p[..i],
        None => "",
    }
}

pub fn join(base: &str, rel: &str) -> String {
    if is_abs(rel) {
        normalize(rel)
    } else {
        normalize(&format!("{base}/{rel}"))
    }
}

fn eq_comp(a: &str, b: &str, ci: bool) -> bool {
    if ci {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// Path of `p` relative to `root` (both normalised absolute). Falls back to `p` if they share
/// nothing (e.g. different drives).
pub fn rel(p: &str, root: &str) -> String {
    let ci = p.as_bytes().get(1) == Some(&b':'); // Windows → case-insensitive
    let a: Vec<&str> = p.split('/').filter(|s| !s.is_empty()).collect();
    let b: Vec<&str> = root.split('/').filter(|s| !s.is_empty()).collect();
    let mut i = 0;
    while i < a.len() && i < b.len() && eq_comp(a[i], b[i], ci) {
        i += 1;
    }
    if i == 0 && (ci || !p.starts_with('/')) {
        return p.to_string();
    }
    let mut out: Vec<&str> = vec![".."; b.len() - i];
    out.extend_from_slice(&a[i..]);
    if out.is_empty() {
        ".".into()
    } else {
        out.join("/")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths() {
        assert_eq!(url_to_path("file:///home/a/src/x%20y.ts"), "/home/a/src/x y.ts");
        assert_eq!(url_to_path("file:///C:/p/src/a.ts"), "C:/p/src/a.ts");
        assert_eq!(normalize("/a/b/../c/./d"), "/a/c/d");
        assert_eq!(rel("/a/b/c.ts", "/a"), "b/c.ts");
        assert_eq!(rel("/a/b/c.ts", "/a/x"), "../b/c.ts");
        assert_eq!(rel("C:/P/src/a.ts", "c:/p"), "src/a.ts");
        assert_eq!(join("/a/src", "price.ts"), "/a/src/price.ts");
        assert_eq!(join("/a/src", "../lib/x.ts"), "/a/lib/x.ts");
        assert_eq!(normalize("c:\\P\\src\\a.ts"), "C:/P/src/a.ts");
        assert_eq!(fold_key("C:/P/A.ts", false), "c:/p/a.ts");
        assert_eq!(fold_key("/P/A.ts", false), "/P/A.ts");
        // NFC (D2.3): NFD "c + caron" equals the precomposed form
        assert_eq!(normalize("src/c\u{30c}esky.ts"), "src/\u{10d}esky.ts");
        assert_eq!(fold_key("src/C\u{30c}.ts", true), "src/\u{10d}.ts");
        // UNC roots keep their double slash (REVIEW-2-architecture N9)
        assert_eq!(normalize("\\\\srv\\share\\p\\..\\q"), "//srv/share/q");
        assert!(is_abs("//srv/share/q"));
    }

    #[test]
    fn path_identity_fixture() {
        let j: serde_json::Value =
            serde_json::from_str(include_str!("../../contracts/fixtures/path-identity.json")).unwrap();
        for c in j["cases"].as_array().unwrap() {
            let ci = c["caseInsensitive"].as_bool().unwrap();
            let (a, b) = (c["a"].as_str().unwrap(), c["b"].as_str().unwrap());
            let same = fold_key(&normalize(a), ci) == fold_key(&normalize(b), ci);
            assert_eq!(same, c["same"].as_bool().unwrap(), "{a:?} vs {b:?} (ci={ci})");
        }
    }

    #[test]
    fn case_probe_matches_this_file_system() {
        let d = std::env::temp_dir().join(format!("vto-CaseProbe-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("package.json"), "{}").unwrap();
        let expect = d.join("PACKAGE.JSON").exists();
        assert_eq!(detect_case_insensitive(&canonical_root(&d)), expect);
        std::fs::remove_dir_all(&d).ok();
    }
}
