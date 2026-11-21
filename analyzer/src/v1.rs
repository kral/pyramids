//! v1 (fallback) input: raw V8 precise coverage + transformed script sources.
//!
//! Pipeline per script: UTF-16 view of the source → significance classes (whitespace,
//! comments and `{}()[];,` are insignificant; Vite helper lines are blanked) → mapping
//! (inline source map, or a token-alignment heuristic against the original file on disk when the
//! map is missing) → atoms from the union of all tests' interval boundaries → items.

use crate::flatten::{Flat, Interval};
use crate::model::{FileTable, Item, Model, TestMeta, UnitBuilder};
use crate::paths;
use crate::sourcemap::{self, Mappings, Seg};
use rayon::prelude::*;
use rustc_hash::FxHashMap;

pub struct V1Test {
    pub meta: TestMeta,
    pub cov: Vec<(String, Flat)>,
}

struct Script {
    path: String,
    line_starts: Vec<u32>,
    prefix: u32,
    /// prefix sums of significant units
    sig: Vec<u32>,
    /// prefix sums of significant *and mapped* units
    msig: Vec<u32>,
    maps: Mappings,
    /// source index → absolute path
    sources: Vec<String>,
    warn: Option<String>,
}

const HELPERS: &[&str] = &[
    "__vite_ssr_exportName__(",
    "__vite_ssr_exportAll__(",
    "Object.defineProperty(__vite_ssr_exports__",
    "const __vite_ssr_import_",
    "const __vite_ssr_dynamic_import_",
];

fn is_word(u: u16) -> bool {
    (u >= b'a' as u16 && u <= b'z' as u16)
        || (u >= b'A' as u16 && u <= b'Z' as u16)
        || (u >= b'0' as u16 && u <= b'9' as u16)
        || u == b'_' as u16
        || u == b'$' as u16
        || u > 127
}

/// 1 = significant unit, 0 = whitespace / comment / structural punctuation.
pub fn classify(s: &[u16]) -> Vec<u8> {
    let n = s.len();
    let mut cls = vec![0u8; n];
    let mut i = 0;
    let c = |x: u8| x as u16;
    while i < n {
        let u = s[i];
        if u == c(b'/') && i + 1 < n && s[i + 1] == c(b'/') {
            while i < n && s[i] != c(b'\n') {
                i += 1;
            }
            continue;
        }
        if u == c(b'/') && i + 1 < n && s[i + 1] == c(b'*') {
            i += 2;
            while i < n && !(s[i] == c(b'*') && i + 1 < n && s[i + 1] == c(b'/')) {
                i += 1;
            }
            i = (i + 2).min(n);
            continue;
        }
        if u == c(b'"') || u == c(b'\'') || u == c(b'`') {
            let q = u;
            cls[i] = 1;
            i += 1;
            while i < n && s[i] != q {
                if q != c(b'`') && s[i] == c(b'\n') {
                    break;
                }
                cls[i] = 1;
                if s[i] == c(b'\\') && i + 1 < n {
                    cls[i + 1] = 1;
                    i += 1;
                }
                i += 1;
            }
            if i < n {
                cls[i] = 1;
                i += 1;
            }
            continue;
        }
        let insig = matches!(u, 0x20 | 0x09 | 0x0a | 0x0d | 0x0b | 0x0c | 0xa0 | 0xfeff | 0x2028 | 0x2029)
            || [b'{', b'}', b'(', b')', b'[', b']', b';', b','].iter().any(|&p| u == c(p));
        cls[i] = !insig as u8;
        i += 1;
    }
    cls
}

fn prefix_sums(v: impl Iterator<Item = u8>, n: usize) -> Vec<u32> {
    let mut p = Vec::with_capacity(n + 1);
    let mut acc = 0u32;
    p.push(0);
    for x in v {
        acc += x as u32;
        p.push(acc);
    }
    p
}

fn line_tokens(s: &[u16]) -> Vec<u64> {
    use std::hash::{Hash, Hasher};
    let mut out = Vec::new();
    let mut i = 0;
    while i < s.len() {
        if is_word(s[i]) {
            let st = i;
            while i < s.len() && is_word(s[i]) {
                i += 1;
            }
            let mut h = rustc_hash::FxHasher::default();
            s[st..i].hash(&mut h);
            out.push(h.finish());
        } else {
            i += 1;
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

fn common(a: &[u64], b: &[u64]) -> u32 {
    let (mut i, mut j, mut n) = (0, 0, 0);
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                n += 1;
                i += 1;
                j += 1;
            }
        }
    }
    n
}

/// Monotone alignment of generated lines to original lines maximising shared tokens.
/// Returns for each generated line (in `gen`) the matched original line index, if any.
pub fn align(gl: &[Vec<u64>], orig: &[Vec<u64>]) -> Vec<Option<u32>> {
    let (n, m) = (gl.len(), orig.len());
    if n == 0 || m == 0 {
        return vec![None; n];
    }
    if (n as u64) * (m as u64) > 40_000_000 {
        // too big for the DP: proportional mapping
        return (0..n).map(|i| Some((i * m / n) as u32)).collect();
    }
    let w = m + 1;
    let mut dp = vec![0u32; (n + 1) * w];
    for i in 1..=n {
        for j in 1..=m {
            let sc = common(&gl[i - 1], &orig[j - 1]);
            let diag = if sc > 0 { dp[(i - 1) * w + j - 1] + sc } else { 0 };
            dp[i * w + j] = dp[(i - 1) * w + j].max(dp[i * w + j - 1]).max(diag);
        }
    }
    let mut res = vec![None; n];
    let (mut i, mut j) = (n, m);
    while i > 0 && j > 0 {
        let sc = common(&gl[i - 1], &orig[j - 1]);
        if sc > 0 && dp[i * w + j] == dp[(i - 1) * w + j - 1] + sc {
            res[i - 1] = Some((j - 1) as u32);
            i -= 1;
            j -= 1;
        } else if dp[i * w + j] == dp[(i - 1) * w + j] {
            i -= 1;
        } else {
            j -= 1;
        }
    }
    res
}

impl Script {
    fn build(url: &str, source: &str) -> Script {
        let path = paths::url_to_path(url);
        let s: Vec<u16> = source.encode_utf16().collect();
        let n = s.len();
        let mut line_starts = vec![0u32];
        for (i, &u) in s.iter().enumerate() {
            if u == b'\n' as u16 {
                line_starts.push(i as u32 + 1);
            }
        }
        let line_end = |l: usize| -> usize {
            if l + 1 < line_starts.len() {
                line_starts[l + 1] as usize - 1
            } else {
                n
            }
        };
        // wrapper prefix: "'use strict';async (...)=>{{" (Vitest) or "...=>{"
        let first: String = String::from_utf16_lossy(&s[..line_end(0)]);
        let prefix = if first.starts_with("'use strict';async (") {
            match first.find(")=>{") {
                Some(i) => {
                    let mut p = i + 4;
                    if first.as_bytes().get(p) == Some(&b'{') {
                        p += 1;
                    }
                    first[..p].encode_utf16().count() as u32
                }
                None => 0,
            }
        } else {
            0
        };
        let mut cls = classify(&s);
        // blank Vite helper lines and the wrapper prefix
        let mut helper = vec![false; line_starts.len()];
        for l in 0..line_starts.len() {
            let mut st = line_starts[l] as usize + if l == 0 { prefix as usize } else { 0 };
            let e = line_end(l);
            while st < e && (s[st] == 0x20 || s[st] == 0x09) {
                st += 1;
            }
            let head = &s[st..e.min(st + 64)];
            if HELPERS.iter().any(|h| head.len() >= h.len() && h.bytes().zip(head).all(|(a, &b)| a as u16 == b)) {
                helper[l] = true;
                cls[line_starts[l] as usize..e].fill(0);
            }
        }
        cls[..(prefix as usize).min(n)].fill(0);
        let sig = prefix_sums(cls.iter().copied(), n);

        let mut warn = None;
        let (maps, sources) = match sourcemap::extract_inline_map(source) {
            Ok(Some(sm)) => {
                let dir = paths::dirname(&path).to_string();
                let srcs = sm
                    .sources
                    .iter()
                    .map(|x| {
                        let x = x.strip_prefix("file://").unwrap_or(x);
                        let j = paths::join(&dir, x);
                        // Vite sometimes emits root-relative "/src/x.ts" – prefer the script path
                        if !std::path::Path::new(&j).exists() && sm.sources.len() == 1 {
                            path.clone()
                        } else {
                            j
                        }
                    })
                    .collect();
                (sm.mappings, srcs)
            }
            r => {
                let had_err = r.is_err();
                if let Err(e) = r {
                    warn = Some(format!("{path}: source map unusable ({e}), using line alignment"));
                }
                // fallback: align transformed lines to the original file by shared tokens
                let mut gen_idx = Vec::new();
                let mut gen_tok = Vec::new();
                for l in 0..line_starts.len() {
                    let st = line_starts[l] as usize + if l == 0 { prefix as usize } else { 0 };
                    let e = line_end(l);
                    if helper[l] || st >= e || sig[e] == sig[st.min(e)] {
                        continue;
                    }
                    let t = line_tokens(&s[st..e]);
                    if !t.is_empty() {
                        gen_idx.push(l);
                        gen_tok.push(t);
                    }
                }
                let mut lines = vec![Vec::new(); line_starts.len()];
                match std::fs::read_to_string(&path) {
                    Ok(orig) => {
                        let otok: Vec<Vec<u64>> = orig
                            .split('\n')
                            .map(|l| line_tokens(&l.encode_utf16().collect::<Vec<_>>()))
                            .collect();
                        let al = align(&gen_tok, &otok);
                        let mut last: Option<u32> = None;
                        for (k, &l) in gen_idx.iter().enumerate() {
                            let o = al[k].or(last);
                            if let Some(o) = o {
                                lines[l].push(Seg { col: 0, src: 0, line: o });
                                last = Some(o);
                            }
                        }
                        if warn.is_none() && !had_err {
                            warn = Some(format!(
                                "{path}: no inline source map in script source, lines aligned heuristically to the file on disk"
                            ));
                        }
                    }
                    Err(_) => {
                        for &l in &gen_idx {
                            lines[l].push(Seg { col: 0, src: 0, line: l as u32 });
                        }
                        warn = Some(format!(
                            "{path}: no source map and original file not readable – reported lines are lines of the TRANSFORMED code"
                        ));
                    }
                }
                (Mappings { lines }, vec![path.clone()])
            }
        };
        // mapped-significant prefix sums
        let mut mapped = vec![0u8; n];
        for l in 0..line_starts.len() {
            let base = line_starts[l] as usize + if l == 0 { prefix as usize } else { 0 };
            let e = line_end(l);
            let segs = match maps.lines.get(l) {
                Some(x) if !x.is_empty() => x,
                _ => continue,
            };
            for (k, sg) in segs.iter().enumerate() {
                if sg.src < 0 {
                    continue;
                }
                let a = (base + sg.col as usize).min(e);
                let b = segs.get(k + 1).map_or(e, |nx| (base + nx.col as usize).min(e));
                for p in a..b {
                    mapped[p] = cls[p];
                }
            }
        }
        let msig = prefix_sums(mapped.into_iter(), n);
        Script { path, line_starts, prefix, sig, msig, maps, sources, warn }
    }

    fn len(&self) -> u32 {
        (self.sig.len() - 1) as u32
    }

    #[inline]
    fn has_msig(&self, a: u32, b: u32) -> bool {
        let n = self.len();
        let (a, b) = (a.min(n), b.min(n));
        a < b && self.msig[b as usize] > self.msig[a as usize]
    }

    fn line_of(&self, p: u32) -> usize {
        self.line_starts.partition_point(|&s| s <= p) - 1
    }

    fn lookup(&self, p: u32) -> Option<Seg> {
        let l = self.line_of(p);
        let base = self.line_starts[l] + if l == 0 { self.prefix } else { 0 };
        if p < base {
            return None;
        }
        self.maps.lookup(l, p - base).filter(|s| s.src >= 0)
    }

    /// Original (source idx, 0-based line) pairs of significant mapped code inside [a,b).
    fn lines_in(&self, a: u32, b: u32, out: &mut Vec<(i32, u32)>) {
        let b = b.min(self.len());
        if a >= b {
            return;
        }
        let (l0, l1) = (self.line_of(a), self.line_of(b - 1));
        for l in l0..=l1 {
            let base = self.line_starts[l] + if l == 0 { self.prefix } else { 0 };
            let le = self.line_starts.get(l + 1).map_or(self.len(), |&x| x);
            let segs = match self.maps.lines.get(l) {
                Some(x) => x,
                None => continue,
            };
            for (k, sg) in segs.iter().enumerate() {
                if sg.src < 0 {
                    continue;
                }
                let ss = (base + sg.col).min(le);
                let se = segs.get(k + 1).map_or(le, |nx| (base + nx.col).min(le));
                let (x, y) = (ss.max(a), se.min(b));
                if x < y && self.sig[y as usize] > self.sig[x as usize] {
                    out.push((sg.src, sg.line));
                }
            }
        }
    }

    /// Anchor line of a skipped range: last significant mapped unit before it, else first inside.
    fn skip_anchor(&self, a: u32, b: u32) -> Option<(i32, u32)> {
        let before = self.msig[a.min(self.len()) as usize];
        let pos = if before > 0 {
            Some(self.msig.partition_point(|&x| x < before) as u32 - 1)
        } else if self.has_msig(a, b) {
            Some(self.msig.partition_point(|&x| x <= self.msig[a as usize]) as u32 - 1)
        } else {
            None
        }?;
        self.lookup(pos).map(|s| (s.src, s.line))
    }
}

/// Builds the model from v1 records.
pub fn build(scripts: Vec<(String, String)>, tests: Vec<V1Test>, root: &str, warnings: &mut Vec<String>) -> Model {
    // dedupe scripts by url
    let mut by_url: FxHashMap<String, usize> = FxHashMap::default();
    let mut uniq: Vec<(String, String)> = Vec::new();
    for (url, src) in scripts {
        match by_url.get(&url) {
            Some(&i) => {
                if uniq[i].1 != src {
                    warnings.push(format!("{url}: script source differs between worker files, using the first one"));
                }
            }
            None => {
                by_url.insert(url.clone(), uniq.len());
                uniq.push((url, src));
            }
        }
    }
    let scripts: Vec<Script> = uniq.par_iter().map(|(u, s)| Script::build(u, s)).collect();
    for s in &scripts {
        if let Some(w) = &s.warn {
            warnings.push(w.clone());
        }
    }
    // per-script lists of intervals / skips (test idx, ...)
    let ns = scripts.len();
    let mut per_script: Vec<Vec<(usize, usize)>> = vec![Vec::new(); ns];
    let mut missing = 0usize;
    for (ti, t) in tests.iter().enumerate() {
        for (ci, (url, _)) in t.cov.iter().enumerate() {
            match by_url.get(url) {
                Some(&si) => per_script[si].push((ti, ci)),
                None => missing += 1,
            }
        }
    }
    if missing > 0 {
        warnings.push(format!("{missing} coverage entries reference scripts without a script record (ignored)"));
    }

    struct Atoms {
        bounds: Vec<u32>,
        /// rank[k] = number of kept atoms among atoms < k (len = atoms + 1)
        rank: Vec<u32>,
        kept: Vec<Interval>,
        skips: Vec<Interval>,
    }
    let atoms: Vec<Atoms> = (0..ns)
        .into_par_iter()
        .map(|si| {
            let sc = &scripts[si];
            let mut bounds = Vec::new();
            let mut skips = Vec::new();
            for &(ti, ci) in &per_script[si] {
                let f = &tests[ti].cov[ci].1;
                for &(a, b) in &f.covered {
                    bounds.push(a);
                    bounds.push(b);
                }
                skips.extend(f.skipped.iter().copied().filter(|&(a, b)| sc.has_msig(a, b)));
            }
            bounds.sort_unstable();
            bounds.dedup();
            skips.sort_unstable();
            skips.dedup();
            let na = bounds.len().saturating_sub(1);
            let mut diff = vec![0i32; na + 1];
            for &(ti, ci) in &per_script[si] {
                for &(a, b) in &tests[ti].cov[ci].1.covered {
                    let lo = bounds.binary_search(&a).unwrap();
                    let hi = bounds.binary_search(&b).unwrap();
                    diff[lo] += 1;
                    diff[hi] -= 1;
                }
            }
            let mut rank = Vec::with_capacity(na + 1);
            let mut kept = Vec::new();
            let mut acc = 0i32;
            for k in 0..na {
                rank.push(kept.len() as u32);
                acc += diff[k];
                if acc > 0 && sc.has_msig(bounds[k], bounds[k + 1]) {
                    kept.push((bounds[k], bounds[k + 1]));
                }
            }
            rank.push(kept.len() as u32);
            Atoms { bounds, rank, kept, skips }
        })
        .collect();

    // global item ids: per script [atoms..., skips...]
    let mut offs = Vec::with_capacity(ns);
    let mut total = 0u32;
    for a in &atoms {
        offs.push(total);
        total += (a.kept.len() + a.skips.len()) as u32;
    }

    // items (file + lines)
    let mut ft = FileTable::new(paths::is_windows_path(root));
    let src_ids: Vec<Vec<u32>> = scripts
        .iter()
        .map(|s| s.sources.iter().map(|p| ft.intern(&paths::rel(p, root))).collect())
        .collect();
    let script_file: Vec<u32> = scripts.iter().map(|s| ft.intern(&paths::rel(&s.path, root))).collect();
    let items: Vec<Item> = (0..ns)
        .into_par_iter()
        .flat_map_iter(|si| {
            let sc = &scripts[si];
            let a = &atoms[si];
            let ids = &src_ids[si];
            let sfile = script_file[si];
            let mk = move |v: &mut Vec<(i32, u32)>| -> Item {
                v.sort_unstable();
                v.dedup();
                let file = v.first().and_then(|x| ids.get(x.0 as usize)).copied().unwrap_or(sfile);
                let lines: Vec<u32> = v.iter().filter(|x| ids.get(x.0 as usize) == Some(&file)).map(|x| x.1 + 1).collect();
                let span = (lines.first().copied().unwrap_or(0), lines.last().copied().unwrap_or(0));
                Item { file, lines, span }
            };
            let atoms_it = a.kept.iter().map(move |&(x, y)| {
                let mut v = Vec::new();
                sc.lines_in(x, y, &mut v);
                mk(&mut v)
            });
            let skips_it = a.skips.iter().map(move |&(x, y)| {
                let mut v: Vec<(i32, u32)> = sc.skip_anchor(x, y).into_iter().collect();
                let mut it = mk(&mut v);
                // span of a skipped block = all its lines (for `affected`)
                let mut w = Vec::new();
                sc.lines_in(x, y, &mut w);
                for (s, l) in w {
                    if ids.get(s as usize) == Some(&it.file) {
                        it.span.0 = it.span.0.min(l + 1).max(1);
                        it.span.1 = it.span.1.max(l + 1);
                    }
                }
                it
            });
            atoms_it.chain(skips_it).collect::<Vec<_>>()
        })
        .collect();

    // units
    let test_items: Vec<Vec<u32>> = tests
        .par_iter()
        .map(|t| {
            let mut v = Vec::new();
            for (url, f) in &t.cov {
                let Some(&si) = by_url.get(url) else { continue };
                let a = &atoms[si];
                let off = offs[si];
                for &(x, y) in &f.covered {
                    let lo = a.bounds.binary_search(&x).unwrap();
                    let hi = a.bounds.binary_search(&y).unwrap();
                    v.extend((a.rank[lo]..a.rank[hi]).map(|r| off + r));
                }
                let sk = a.kept.len() as u32;
                for s in &f.skipped {
                    if let Ok(k) = a.skips.binary_search(s) {
                        v.push(off + sk + k as u32);
                    }
                }
            }
            v
        })
        .collect();
    let mut ub = UnitBuilder::new(root);
    for (t, it) in tests.into_iter().zip(test_items) {
        ub.add(t.meta, it);
    }
    let units = ub.finish(warnings);
    Model { files: ft.names, items, units, format: "v1", ..Default::default() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_basic() {
        let s: Vec<u16> = "a { /* c */ } // x\n'b;' ".encode_utf16().collect();
        let c = classify(&s);
        let sig: String = s.iter().zip(&c).filter(|&(_, &k)| k == 1).map(|(&u, _)| u as u8 as char).collect();
        assert_eq!(sig, "a'b;'");
    }

    #[test]
    fn alignment_skips_inserted_lines() {
        let t = |x: &str| line_tokens(&x.encode_utf16().collect::<Vec<_>>());
        let gl = vec![t("function price(base, qty, vip = false) {"), t("if (qty <= 0) throw new Error(\"qty\");"), t("return n")];
        let orig = vec![t("import x from 'y'"), t("export function price(base: number, qty: number, vip = false): number {"), t("  if (qty <= 0) throw new Error('qty');"), t("return n")];
        assert_eq!(align(&gl, &orig), vec![Some(1), Some(2), Some(3)]);
    }

    #[test]
    fn utf16_offsets_with_non_ascii() {
        // "Kč" – č is 1 UTF-16 unit but 2 UTF-8 bytes; 😀 is 2 UTF-16 units
        let src = "let a = '😀č';\nlet b = 1;\n";
        let sc = Script::build("file:///nonexistent/x.js", src);
        // 'let b' starts at UTF-16 offset 15 ("let a = '" 9 + 😀 2 + "č';" 3 + "\n" 1)
        assert_eq!(sc.line_starts, vec![0, 15, 26]);
        let mut v = Vec::new();
        sc.lines_in(15, 25, &mut v);
        assert_eq!(v, vec![(0, 1)]);
    }

    #[test]
    fn mapping_with_wrapper_prefix() {
        // prefix "'use strict';async (a)=>{{" shifts only line 0 columns
        use base64::Engine;
        let map = r#"{"version":3,"sources":["o.ts"],"mappings":"AAAA,KACA;AACA"}"#;
        let b64 = base64::engine::general_purpose::STANDARD.encode(map);
        let src = format!("'use strict';async (a)=>{{{{x(1); y(2);\nz(3);\n//# sourceMappingURL=data:application/json;base64,{b64}\n}}}}");
        let sc = Script::build("file:///nonexistent/o.js", &src);
        assert_eq!(sc.prefix, 26);
        // "y" at code col 5 → segment col 5 → orig line 1
        let ypos = src.find("y(2)").unwrap() as u32;
        assert_eq!(sc.lookup(ypos), Some(Seg { col: 5, src: 0, line: 1 }));
        assert_eq!(sc.lookup(3), None); // inside wrapper prefix
        let zpos = src.find("z(3)").unwrap() as u32;
        assert_eq!(sc.lookup(zpos).unwrap().line, 2);
    }
}
