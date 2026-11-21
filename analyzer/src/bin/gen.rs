//! Synthetic raw-data generator for benchmarking.
//!
//!   cargo run --release --bin gen -- N_TESTS N_ATOMS OUT_DIR [--v1] [--dense] [--seed S] [--workers W]
//!
//! `--dense`: every test also hits the same 320 "app shell" blocks and only 1–4 own functions
//! (worst case for near pairs / subsets – checks that output stays bounded).
//!
//! v2 (default): `file` records with blocks + `test` records with `hits`, durationMs, assertions.
//! v1 (`--v1`): `script` records (wrapper prefix + code + inline identity source map) + V8 `cov`.
//!
//! Shape: files of ~400 blocks; functions of 8 blocks (body + 7 statements/branches); tests are
//! grouped into test files of 20 that exercise a cluster of 3 source files; every test also hits
//! a few "popular" util functions; ~10 % of tests are exact copies, ~10 % near copies.
use base64::Engine;
use std::io::Write;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
    fn chance(&mut self, p: f64) -> bool {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64 <= p
    }
}

const FN_BLOCKS: usize = 8;
const WRAP: &str = "'use strict';async (__vite_ssr_exports__,__vite_ssr_import_meta__,__vite_ssr_import__,__vite_ssr_dynamic_import__,__vite_ssr_exportAll__,__vite_ssr_exportName__,__filename,__dirname,module,exports,require)=>{{";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut pos = Vec::new();
    let (mut v1, mut seed, mut workers, mut dense) = (false, 42u64, 4usize, false);
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--v1" => v1 = true,
            "--dense" => dense = true,
            "--seed" => {
                i += 1;
                seed = args[i].parse().unwrap()
            }
            "--workers" => {
                i += 1;
                workers = args[i].parse().unwrap()
            }
            s => pos.push(s.to_string()),
        }
        i += 1;
    }
    if pos.len() != 3 {
        eprintln!("usage: gen N_TESTS N_ATOMS OUT_DIR [--v1] [--seed S] [--workers W]");
        std::process::exit(2);
    }
    let n_tests: usize = pos[0].parse().unwrap();
    let n_atoms: usize = pos[1].parse().unwrap();
    let out = std::path::PathBuf::from(&pos[2]);
    std::fs::create_dir_all(&out).unwrap();
    for e in std::fs::read_dir(&out).unwrap().flatten() {
        if e.file_name().to_string_lossy().starts_with("w-") {
            std::fs::remove_file(e.path()).unwrap();
        }
    }
    let mut rng = Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1);

    let fns_per_file = 50usize; // 400 blocks per file
    let n_files = (n_atoms / (fns_per_file * FN_BLOCKS)).max(2);
    let files: Vec<String> = (0..n_files).map(|f| format!("/proj/src/mod{f:04}.ts")).collect();
    let util = 0usize; // file 0 = popular utils

    // test records: (test file, name, line, hits: file → sorted block ids)
    struct T {
        file: usize,
        line: usize,
        hits: Vec<Vec<u32>>,
        dur: f64,
        asr: u32,
    }
    let per_tf = 20;
    let mut tests: Vec<T> = Vec::with_capacity(n_tests);
    let mut cluster = [1usize; 3];
    for ti in 0..n_tests {
        let tf = ti / per_tf;
        if ti % per_tf == 0 {
            for c in cluster.iter_mut() {
                *c = 1 + rng.below(n_files as u64 - 1) as usize;
            }
        }
        let line = 3 + (ti % per_tf) * 4;
        let start_of_tf = tf * per_tf;
        let dur = (0.2 + rng.below(1000) as f64 / 100.0) * if rng.chance(0.05) { 30.0 } else { 1.0 };
        let asr = if rng.chance(0.03) { 0 } else { 1 + rng.below(4) as u32 };
        if ti > start_of_tf && rng.chance(0.2) {
            // copy of an earlier test in the same test file (exact or with 1-2 toggled blocks)
            let src = start_of_tf + rng.below((ti - start_of_tf) as u64) as usize;
            let mut hits = tests[src].hits.clone();
            if rng.chance(0.5) {
                for _ in 0..1 + rng.below(2) {
                    let nonempty: Vec<usize> = (0..n_files).filter(|&f| !hits[f].is_empty()).collect();
                    let f = nonempty[rng.below(nonempty.len() as u64) as usize];
                    let fnn = hits[f][rng.below(hits[f].len() as u64) as usize] as usize / FN_BLOCKS;
                    let b = (fnn * FN_BLOCKS + 1 + rng.below(FN_BLOCKS as u64 - 1) as usize) as u32;
                    match hits[f].binary_search(&b) {
                        Ok(k) => {
                            hits[f].remove(k);
                        }
                        Err(k) => hits[f].insert(k, b),
                    }
                }
            }
            tests.push(T { file: tf, line, hits, dur, asr });
            continue;
        }
        let mut hits: Vec<Vec<u32>> = vec![Vec::new(); n_files];
        let add_fn = |rng: &mut Rng, hits: &mut Vec<Vec<u32>>, f: usize, fnn: usize, p: f64| {
            let base = (fnn * FN_BLOCKS) as u32;
            hits[f].push(base);
            for k in 1..FN_BLOCKS as u32 {
                if rng.chance(p) {
                    hits[f].push(base + k);
                }
            }
        };
        if dense {
            // "render(<App/>)" in every test: 40 shared util functions fully hit
            for fnn in 0..40 {
                add_fn(&mut rng, &mut hits, util, fnn, 1.0);
            }
        } else {
            for _ in 0..3 {
                let fnn = rng.below(10) as usize;
                add_fn(&mut rng, &mut hits, util, fnn, 0.9);
            }
        }
        let k = if dense { 1 + rng.below(4) as usize } else { 5 + rng.below(36) as usize };
        for _ in 0..k {
            let f = cluster[rng.below(3) as usize];
            // functions of a cluster file are used with a skewed distribution
            let fnn = (rng.below(fns_per_file as u64) * rng.below(fns_per_file as u64) / fns_per_file as u64) as usize;
            add_fn(&mut rng, &mut hits, f, fnn, 0.6);
        }
        for h in hits.iter_mut() {
            h.sort_unstable();
            h.dedup();
        }
        tests.push(T { file: tf, line, hits, dur, asr });
    }

    // sources for v1: one line per block
    let mut srcs: Vec<(String, Vec<(u32, u32)>)> = Vec::new(); // (source, per block (start,end) utf16 offsets)
    if v1 {
        for f in 0..n_files {
            let mut s = String::from(WRAP);
            s.push_str(&format!("__vite_ssr_exportName__(\"f0\", () => {{ try {{ return f0 }} catch {{}} }});\n"));
            let mut spans = Vec::new();
            let mut map = String::from("AAAA");
            for fnn in 0..fns_per_file {
                let st = s.len() as u32;
                s.push_str(&format!("function f{fnn}(x) {{\n"));
                map.push_str(";AACA");
                let mut inner = Vec::new();
                for k in 1..FN_BLOCKS {
                    let ls = s.len() as u32 + 1;
                    s.push_str(&format!("\tif (x > {k}) v{k} = calc{f}_{fnn}_{k}(x);\n"));
                    inner.push((ls, s.len() as u32 - 1));
                    map.push_str(";AACA");
                }
                s.push_str("}\n");
                map.push_str(";AACA");
                spans.push((st, s.len() as u32 - 1));
                spans.extend(inner);
            }
            let sm = format!(r#"{{"version":3,"sources":["mod{f:04}.ts"],"names":[],"mappings":"{map}"}}"#);
            s.push_str(&format!(
                "\n//# sourceMappingURL=data:application/json;base64,{}\n}}}}",
                base64::engine::general_purpose::STANDARD.encode(sm)
            ));
            srcs.push((s, spans));
        }
    }

    let mut ws: Vec<std::io::BufWriter<std::fs::File>> = (0..workers)
        .map(|w| std::io::BufWriter::new(std::fs::File::create(out.join(format!("w-{}-0.jsonl", 1000 + w))).unwrap()))
        .collect();
    for w in ws.iter_mut() {
        writeln!(w, r#"{{"t":"meta","gitHead":"0000000000000000000000000000000000000000"}}"#).unwrap();
        for f in 0..n_files {
            if v1 {
                let url = format!("file://{}", files[f]);
                writeln!(w, "{}", serde_json::json!({"t":"script","url":url,"source":srcs[f].0})).unwrap();
            } else {
                let mut b = String::with_capacity(fns_per_file * FN_BLOCKS * 24);
                for fnn in 0..fns_per_file {
                    let l0 = 1 + fnn * (FN_BLOCKS + 1);
                    b.push_str(&format!("[{l0},0,{},1,\"f\"],", l0 + FN_BLOCKS));
                    for k in 1..FN_BLOCKS {
                        b.push_str(&format!("[{0},2,{0},30,\"{1}\"],", l0 + k, if k % 2 == 0 { "b" } else { "s" }));
                    }
                }
                b.pop();
                writeln!(w, r#"{{"t":"file","file":"{}","blocks":[{b}]}}"#, files[f]).unwrap();
            }
        }
    }
    for t in &tests {
        let w = &mut ws[t.file % workers];
        let tfile = format!("/proj/test/t{:05}.test.ts", t.file);
        let name = format!("suite {} > case {}", t.file, t.line);
        let mut line = String::with_capacity(4096);
        if v1 {
            line.push_str(&format!(
                r#"{{"t":"test","file":"{tfile}","name":"{name}","line":{},"state":"pass","cov":["#,
                t.line
            ));
            let mut first = true;
            for (f, h) in t.hits.iter().enumerate() {
                if h.is_empty() {
                    continue;
                }
                if !first {
                    line.push(',');
                }
                first = false;
                line.push_str(&format!(r#"{{"url":"file://{}","functions":["#, files[f]));
                let spans = &srcs[f].1;
                let mut i = 0;
                let mut firstfn = true;
                while i < h.len() {
                    let fnn = h[i] as usize / FN_BLOCKS;
                    let base = fnn * FN_BLOCKS;
                    let mut hit = [false; FN_BLOCKS];
                    while i < h.len() && h[i] as usize / FN_BLOCKS == fnn {
                        hit[h[i] as usize - base] = true;
                        i += 1;
                    }
                    if !firstfn {
                        line.push(',');
                    }
                    firstfn = false;
                    let (a, b) = spans[base];
                    line.push_str(&format!("[[{a},{b},1]"));
                    for k in 1..FN_BLOCKS {
                        if !hit[k] {
                            let (a, b) = spans[base + k];
                            line.push_str(&format!(",[{a},{b},0]"));
                        }
                    }
                    line.push(']');
                }
                line.push_str("]}");
            }
            line.push_str("]}");
        } else {
            line.push_str(&format!(
                r#"{{"t":"test","file":"{tfile}","name":"{name}","line":{},"state":"pass","durationMs":{:.2},"assertions":{},"hits":{{"#,
                t.line, t.dur, t.asr
            ));
            let mut first = true;
            for (f, h) in t.hits.iter().enumerate() {
                if h.is_empty() {
                    continue;
                }
                if !first {
                    line.push(',');
                }
                first = false;
                line.push_str(&format!("\"{}\":[", files[f]));
                line.push_str(&h.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","));
                line.push(']');
            }
            line.push_str("}}");
        }
        writeln!(w, "{line}").unwrap();
    }
    if !v1 {
        // fileload per test file: modules used by its tests + 3 imported-but-unused ones
        let n_tf = tests.last().map_or(0, |t| t.file + 1);
        let mut used: Vec<Vec<bool>> = vec![vec![false; n_files]; n_tf];
        for t in &tests {
            for (f, h) in t.hits.iter().enumerate() {
                if !h.is_empty() {
                    used[t.file][f] = true;
                }
            }
        }
        for tf in 0..n_tf {
            let mut mods: Vec<usize> = (0..n_files).filter(|&f| used[tf][f]).collect();
            for _ in 0..3 {
                mods.push(rng.below(n_files as u64) as usize);
            }
            mods.sort_unstable();
            mods.dedup();
            let entries: Vec<String> = mods
                .iter()
                .map(|&f| format!(r#"{{"file":"{}","loadMs":{:.2}}}"#, files[f], 0.5 + rng.below(2000) as f64 / 100.0))
                .collect();
            writeln!(
                ws[tf % workers],
                r#"{{"t":"fileload","testFile":"/proj/test/t{tf:05}.test.ts","hits":{{}},"modules":[{}]}}"#,
                entries.join(",")
            )
            .unwrap();
        }
    }
    for mut w in ws {
        w.flush().unwrap();
    }
    eprintln!(
        "gen: {} tests, {} files × {} blocks = {} blocks ({}) → {}",
        n_tests,
        n_files,
        fns_per_file * FN_BLOCKS,
        n_files * fns_per_file * FN_BLOCKS,
        if v1 { "v1/V8" } else { "v2" },
        out.display()
    );
}
