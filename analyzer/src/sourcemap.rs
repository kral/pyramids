//! Minimal source map v3 support: base64 VLQ decoding of `mappings`, inline data-URL maps.

use base64::Engine;

/// One mapping segment on a generated line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Seg {
    /// Generated column (UTF-16 code units, relative to the start of the generated line).
    pub col: u32,
    /// Source index, or -1 for a segment without an original position.
    pub src: i32,
    /// Original line (0-based); meaningless when `src < 0`.
    pub line: u32,
}

/// Mapping table: `lines[gen_line]` = segments sorted by `col`.
#[derive(Debug, Default, Clone)]
pub struct Mappings {
    pub lines: Vec<Vec<Seg>>,
}

impl Mappings {
    /// Segment covering `col` on generated line `line` (last segment with `seg.col <= col`).
    pub fn lookup(&self, line: usize, col: u32) -> Option<Seg> {
        let segs = self.lines.get(line)?;
        let i = segs.partition_point(|s| s.col <= col);
        if i == 0 {
            None
        } else {
            Some(segs[i - 1])
        }
    }
}

#[inline]
fn b64val(c: u8) -> Option<i64> {
    Some(match c {
        b'A'..=b'Z' => (c - b'A') as i64,
        b'a'..=b'z' => (c - b'a') as i64 + 26,
        b'0'..=b'9' => (c - b'0') as i64 + 52,
        b'+' => 62,
        b'/' => 63,
        _ => return None,
    })
}

/// Decodes one base64 VLQ value starting at `*pos`.
pub fn decode_vlq(bytes: &[u8], pos: &mut usize) -> Result<i64, String> {
    let mut result: i64 = 0;
    let mut shift = 0u32;
    loop {
        let c = *bytes.get(*pos).ok_or("unexpected end of VLQ")?;
        *pos += 1;
        let v = b64val(c).ok_or_else(|| format!("invalid VLQ char {:?}", c as char))?;
        if shift > 60 {
            return Err("VLQ overflow".into());
        }
        result |= (v & 31) << shift;
        if v & 32 == 0 {
            break;
        }
        shift += 5;
    }
    let neg = result & 1 == 1;
    let mag = result >> 1;
    Ok(if neg { -mag } else { mag })
}

/// Parses the `mappings` string of a source map v3.
pub fn parse_mappings(m: &str) -> Result<Mappings, String> {
    let b = m.as_bytes();
    let mut lines: Vec<Vec<Seg>> = vec![Vec::new()];
    let (mut src, mut oline, mut ocol, mut name) = (0i64, 0i64, 0i64, 0i64);
    let mut gcol: i64 = 0;
    let mut pos = 0usize;
    while pos < b.len() {
        match b[pos] {
            b';' => {
                lines.push(Vec::new());
                gcol = 0;
                pos += 1;
                continue;
            }
            b',' => {
                pos += 1;
                continue;
            }
            _ => {}
        }
        let mut fields = [0i64; 5];
        let mut n = 0;
        while pos < b.len() && b[pos] != b',' && b[pos] != b';' {
            if n == 5 {
                return Err("segment with more than 5 fields".into());
            }
            fields[n] = decode_vlq(b, &mut pos)?;
            n += 1;
        }
        gcol += fields[0];
        let seg = if n >= 4 {
            src += fields[1];
            oline += fields[2];
            ocol += fields[3];
            if n == 5 {
                name += fields[4];
            }
            if src < 0 || oline < 0 {
                return Err("negative source/line in mappings".into());
            }
            Seg { col: gcol.max(0) as u32, src: src as i32, line: oline as u32 }
        } else if n == 1 {
            Seg { col: gcol.max(0) as u32, src: -1, line: 0 }
        } else {
            return Err(format!("segment with {n} fields"));
        };
        lines.last_mut().unwrap().push(seg);
    }
    let _ = (ocol, name);
    for l in &mut lines {
        // spec says sorted, but be defensive (stable keeps the later of equal columns last)
        if !l.windows(2).all(|w| w[0].col <= w[1].col) {
            l.sort_by_key(|s| s.col);
        }
    }
    Ok(Mappings { lines })
}

/// Parsed source map: mappings + list of sources (already joined with `sourceRoot`).
#[derive(Debug, Default, Clone)]
pub struct SourceMap {
    pub mappings: Mappings,
    pub sources: Vec<String>,
}

#[derive(serde::Deserialize)]
struct RawMap {
    #[serde(default)]
    mappings: String,
    #[serde(default)]
    sources: Vec<Option<String>>,
    #[serde(default, rename = "sourceRoot")]
    source_root: Option<String>,
    #[serde(default)]
    sections: Option<serde_json::Value>,
}

pub fn parse_map_json(json: &[u8]) -> Result<SourceMap, String> {
    let raw: RawMap = serde_json::from_slice(json).map_err(|e| format!("source map JSON: {e}"))?;
    if raw.sections.is_some() {
        return Err("indexed source maps (sections) are not supported".into());
    }
    let root = raw.source_root.unwrap_or_default();
    let sources = raw
        .sources
        .into_iter()
        .map(|s| {
            let s = s.unwrap_or_default();
            if root.is_empty() || s.starts_with('/') || s.contains("://") {
                s
            } else if root.ends_with('/') {
                format!("{root}{s}")
            } else {
                format!("{root}/{s}")
            }
        })
        .collect();
    Ok(SourceMap { mappings: parse_mappings(&raw.mappings)?, sources })
}

/// Finds the last `//# sourceMappingURL=data:...` comment and decodes it.
/// Returns `Ok(None)` when there is no inline map.
pub fn extract_inline_map(source: &str) -> Result<Option<SourceMap>, String> {
    let mut found = None;
    for pat in ["//# sourceMappingURL=", "//@ sourceMappingURL="] {
        if let Some(i) = source.rfind(pat) {
            if found.map_or(true, |(j, _)| i > j) {
                found = Some((i, pat.len()));
            }
        }
    }
    let Some((i, plen)) = found else { return Ok(None) };
    let rest = &source[i + plen..];
    let url = rest.split(|c: char| c.is_whitespace()).next().unwrap_or("");
    let Some(data) = url.strip_prefix("data:") else {
        return Err(format!("non-inline source map URL not supported: {}", &url[..url.len().min(80)]));
    };
    let comma = data.find(',').ok_or("malformed data URL")?;
    let (meta, payload) = (&data[..comma], &data[comma + 1..]);
    let bytes = if meta.split(';').any(|p| p == "base64") {
        base64::engine::general_purpose::STANDARD
            .decode(payload.trim_end_matches('='))
            .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(payload.trim_end_matches('=')))
            .map_err(|e| format!("base64: {e}"))?
    } else {
        percent_decode(payload)
    };
    parse_map_json(&bytes).map(Some)
}

pub fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() + 0 && i + 2 <= b.len() - 1 {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

fn hex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vlq(s: &str) -> Vec<i64> {
        let b = s.as_bytes();
        let mut p = 0;
        let mut v = vec![];
        while p < b.len() {
            v.push(decode_vlq(b, &mut p).unwrap());
        }
        v
    }

    #[test]
    fn vlq_basic() {
        assert_eq!(vlq("A"), vec![0]);
        assert_eq!(vlq("C"), vec![1]);
        assert_eq!(vlq("D"), vec![-1]);
        assert_eq!(vlq("gB"), vec![16]);
        assert_eq!(vlq("hB"), vec![-16]);
        assert_eq!(vlq("2H"), vec![123]);
        assert_eq!(vlq("+/D"), vec![2047]);
        assert_eq!(vlq("/B"), vec![-31]);
        assert_eq!(vlq("AACpE"), vec![0, 0, 1, -68]);
        assert!(decode_vlq(b"g", &mut 0).is_err());
        assert!(decode_vlq(b"!", &mut 0).is_err());
    }

    #[test]
    fn mappings_relative_fields() {
        // line0: col0→(0,0,0) col1→(0,0,0); line1 empty; line2: col0→(0,0,7) col9→(0,0,16); line3: col1→(0,1,2)
        let m = parse_mappings("AAAA,CAAA;;AAAO,SAAS;CACpE").unwrap();
        assert_eq!(m.lines.len(), 4);
        assert_eq!(m.lines[0], vec![Seg { col: 0, src: 0, line: 0 }, Seg { col: 1, src: 0, line: 0 }]);
        assert!(m.lines[1].is_empty());
        assert_eq!(m.lines[2], vec![Seg { col: 0, src: 0, line: 0 }, Seg { col: 9, src: 0, line: 0 }]);
        assert_eq!(m.lines[3], vec![Seg { col: 1, src: 0, line: 1 }]);
        assert_eq!(m.lookup(2, 5), Some(Seg { col: 0, src: 0, line: 0 }));
        assert_eq!(m.lookup(3, 0), None);
        assert_eq!(m.lookup(9, 0), None);
    }

    #[test]
    fn mappings_unmapped_segment() {
        let m = parse_mappings("AAAA,KAAK,E").unwrap();
        assert_eq!(m.lookup(0, 4).unwrap().src, 0);
        assert_eq!(m.lookup(0, 5).unwrap().line, 0);
        assert_eq!(m.lookup(0, 7).unwrap().src, -1);
    }

    #[test]
    fn inline_map_from_fixture() {
        let line = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/with-map/w-574-0.jsonl"))
            .unwrap();
        let rec: serde_json::Value = serde_json::from_str(line.lines().next().unwrap()).unwrap();
        let src = rec["source"].as_str().unwrap();
        let sm = extract_inline_map(src).unwrap().unwrap();
        assert_eq!(sm.sources, vec!["price.ts".to_string()]);
        // generated line 2 = "function price(...)" ↔ original line 0; line 10 "\treturn n.toFixed" ↔ original 8
        assert_eq!(sm.mappings.lookup(2, 0).unwrap().line, 0);
        assert_eq!(sm.mappings.lookup(10, 5).unwrap().line, 8);
        assert!(sm.mappings.lines[1].is_empty()); // second export getter has no mapping
    }

    #[test]
    fn no_inline_map() {
        assert!(extract_inline_map("var x = 1;\n//# vitestCache=abc\n").unwrap().is_none());
        let sm = extract_inline_map("x\n//# sourceMappingURL=data:application/json,%7B%22mappings%22%3A%22AAAA%22%2C%22sources%22%3A%5B%22a.ts%22%5D%7D\n")
            .unwrap()
            .unwrap();
        assert_eq!(sm.sources, vec!["a.ts"]);
    }
}
