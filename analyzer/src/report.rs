//! report.md (English / Czech) and report.json (schema of the Node version + durationMs/assertions).

use crate::analysis::Analysis;
use crate::i18n::{t, tf, Lang};
use crate::imports::Imports;
use crate::model::Model;
use serde::Serialize;
use std::fmt::Write;

pub fn iso_now() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // civil_from_days (H. Hinnant)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let dd = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{dd:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        d.subsec_millis()
    )
}

fn pct(x: f64) -> String {
    format!("{:.0} %", x * 100.0)
}

/// Markdown-safe text (SECURITY-REVIEW F10): see [`crate::sanitize::md`].
fn esc(s: &str) -> String {
    crate::sanitize::md(s)
}

fn ms(x: f64) -> String {
    if x >= 1000.0 {
        format!("{:.2} s", x / 1000.0)
    } else {
        format!("{x:.1} ms")
    }
}

/// "file:1,2; other:5" for a set of item ids
pub fn item_lines(model: &Model, items: &[u32]) -> String {
    let mut by: std::collections::BTreeMap<&str, std::collections::BTreeSet<u32>> = Default::default();
    for &i in items {
        let it = &model.items[i as usize];
        let e = by.entry(model.files[it.file as usize].as_str()).or_default();
        e.extend(it.lines.iter().copied().filter(|&l| l > 0));
    }
    by.into_iter()
        .map(|(f, l)| {
            if l.is_empty() {
                format!("{f}:?")
            } else {
                format!("{f}:{}", l.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","))
            }
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// Size limits of the compact report.md (U-11): the default report must stay reviewable; `--full`
/// lifts every cap (report.json is always complete).
#[derive(Debug, Clone, Copy)]
pub struct MdOpts {
    /// rows per list
    pub top: usize,
    /// identical-coverage groups listed
    pub groups: usize,
    /// tests listed per group
    pub per_group: usize,
    /// include the "All tests" table
    pub all_tests: bool,
}

impl MdOpts {
    pub fn compact(top: Option<usize>) -> Self {
        MdOpts { top: top.unwrap_or(50), groups: 20, per_group: 10, all_tests: false }
    }
    pub fn full(top: Option<usize>) -> Self {
        MdOpts { top: top.unwrap_or(usize::MAX), groups: usize::MAX, per_group: usize::MAX, all_tests: true }
    }
}

pub fn markdown(model: &Model, a: &Analysis, imp: &Imports, threshold: f64, mo: MdOpts, generated: &str, lang: Lang) -> String {
    let top = mo.top;
    let u = &model.units;
    let l = |k: &str| t(lang, k);
    // every attacker-influenced string is escaped (no code spans: a name could close them)
    let nm = |i: usize| {
        format!(
            "**{}** ({})",
            esc(&u[i].names.join(" | ")),
            esc(&format!("{}{}", u[i].file, u[i].line.map_or(String::new(), |l| format!(":{l}"))))
        )
    };
    let nmt = nm;
    let reason = |code: &str| t(lang, &format!("reason.{code}"));
    let dur = |i: usize| u[i].duration_ms.unwrap_or(0.0);
    let has_dur = u.iter().any(|x| x.duration_ms.is_some());
    let has_asr = u.iter().any(|x| x.assertions.is_some());
    let mut md = String::new();
    let item_desc = if model.format == "v2" { l("items.v2") } else { l("items.v1") };
    md += l("title");
    md += &tf(lang, "generated", &[&generated, &u.len(), &a.clean, &a.total_items, &item_desc]);
    md += l("disclaimer");
    if !mo.all_tests {
        md += l("compact.note");
    }

    // first test of every test file (its duration includes imports / JIT warm-up)
    let mut first_in_file = vec![false; u.len()];
    {
        let mut seen = std::collections::HashSet::new();
        for i in 0..u.len() {
            if seen.insert(u[i].file_key().to_string()) {
                first_in_file[i] = true;
            }
        }
    }
    let excl_set: std::collections::HashSet<usize> = a.excluded.iter().copied().collect();
    let slow: Vec<usize> = {
        let mut v: Vec<usize> = (0..u.len())
            .filter(|&i| !excl_set.contains(&i) && a.unique[i] == 0 && a.sizes[i] > 0 && u[i].duration_ms.is_some())
            .collect();
        v.sort_by(|&x, &y| dur(y).partial_cmp(&dur(x)).unwrap().then(x.cmp(&y)));
        v
    };
    let slow_ms: f64 = slow.iter().map(|&i| dur(i)).sum();
    let clean_ms: f64 = (0..u.len()).filter(|i| !excl_set.contains(i)).map(dur).sum();
    let keep_ms: f64 = a.keep.iter().map(|&i| dur(i)).sum();
    let no_asr: Vec<usize> = (0..u.len()).filter(|&i| u[i].assertions == Some(0)).collect();

    md += l("summary.head");
    let line = |md: &mut String, s: String| {
        md.push_str(&s);
        md.push('\n');
    };
    line(&mut md, tf(lang, "summary.identical", &[&a.identical.len(), &a.identical.iter().map(|g| g.units.len()).sum::<usize>()]));
    line(&mut md, tf(lang, "summary.subsumed", &[&a.subsumed.len()]));
    line(&mut md, tf(lang, "summary.near", &[&threshold, &a.near_total]));
    line(&mut md, tf(lang, "summary.minset", &[&a.keep.len(), &(a.clean - a.no_cov.len())]));
    line(&mut md, tf(lang, "summary.nocov", &[&a.no_cov.len()]));
    line(&mut md, tf(lang, "summary.excluded", &[&a.excluded.len()]));
    if has_asr {
        line(&mut md, tf(lang, "summary.noasr", &[&no_asr.len()]));
    }
    if has_dur {
        line(&mut md, tf(lang, "summary.time", &[&ms(clean_ms)]));
        line(&mut md, tf(lang, "summary.slow", &[&ms(slow_ms), &slow.len()]));
    }
    md += "\n";

    md += l("review");
    if !a.identical.is_empty() {
        md += l("identical");
        // ranked: strongest tier first (parametric last), then by the run time a merge could
        // save (everything but the slowest test of the group), then by group size
        let review_ms = |g: &crate::analysis::Group| -> f64 {
            let d: Vec<f64> = g.units.iter().map(|&i| dur(i)).collect();
            d.iter().sum::<f64>() - d.iter().cloned().fold(0.0, f64::max)
        };
        let mut order: Vec<usize> = (0..a.identical.len()).collect();
        order.sort_by(|&x, &y| {
            let (gx, gy) = (&a.identical[x], &a.identical[y]);
            (gx.tier == "parametric")
                .cmp(&(gy.tier == "parametric"))
                .then(review_ms(gy).partial_cmp(&review_ms(gx)).unwrap_or(std::cmp::Ordering::Equal))
                .then(gy.units.len().cmp(&gx.units.len()))
                .then(x.cmp(&y))
        });
        for (rank, &gi) in order.iter().enumerate() {
            if rank == mo.groups {
                let rest: usize = order[rank..].iter().map(|&g| a.identical[g].units.len()).sum();
                line(&mut md, tf(lang, "more.groups", &[&(order.len() - rank), &rest]));
                md += "\n";
                break;
            }
            let g = &a.identical[gi];
            let time = if has_dur { tf(lang, "identical.group.time", &[&ms(review_ms(g))]) } else { String::new() };
            line(&mut md, tf(lang, "identical.group", &[&(rank + 1), &g.units.len(), &a.sizes[g.units[0]], &time, &g.tier]));
            for (k, &i) in g.units.iter().enumerate() {
                if k == mo.per_group {
                    line(&mut md, tf(lang, "more.in.group", &[&(g.units.len() - k)]));
                    break;
                }
                let _ = writeln!(md, "- {}", nm(i));
            }
            md += "\n";
        }
    }
    if !a.subsumed.is_empty() {
        md += l("subsumed");
        for (k, s) in a.subsumed.iter().enumerate() {
            if k == top {
                line(&mut md, tf(lang, "more.tests.json", &[&(a.subsumed.len() - top)]));
                break;
            }
            let shown = s.by.len().min(3);
            let more = if s.by_count > shown { tf(lang, "total.tests", &[&s.by_count]) } else { String::new() };
            let _ = writeln!(
                md,
                "| {} | {}{more} | {} ⊂ {} |",
                nmt(s.unit),
                s.by.iter().take(3).map(|&b| nmt(b)).collect::<Vec<_>>().join("<br>"),
                a.sizes[s.unit],
                a.sizes[s.by[0]]
            );
        }
        md += "\n";
    }
    if !a.near.is_empty() {
        md += l("near");
        if a.common_items > 0 {
            md += &tf(lang, "near.common", &[&a.common_items]);
        }
        if a.near_truncated {
            md += l("near.truncated");
        }
        if a.near_total as usize > a.near.len().min(top) {
            md += &tf(lang, "near.shown", &[&a.near.len().min(top), &a.near_total, &a.near.len()]);
        }
        md += l("near.head");
        let g = |n: usize| if n > 1 { format!(" (+{})", n - 1) } else { String::new() };
        for p in a.near.iter().take(top) {
            let _ = writeln!(
                md,
                "| {}{} | {}{} | {} | {} | {} |",
                nmt(p.a),
                g(p.a_group),
                nmt(p.b),
                g(p.b_group),
                pct(p.jaccard),
                pct(p.a_in_b),
                pct(p.b_in_a)
            );
        }
        md += "\n";
    }
    let time = if has_dur { tf(lang, "minset.time", &[&ms(keep_ms), &ms(clean_ms)]) } else { String::new() };
    md += &tf(lang, "minset", &[&a.keep.len(), &a.total_items, &time]);
    if !a.no_cov.is_empty() {
        let mut list = a.no_cov.iter().take(top).map(|&i| format!("- {}", nm(i))).collect::<Vec<_>>().join("\n");
        if a.no_cov.len() > top {
            list += &tf(lang, "more.tests.json", &[&(a.no_cov.len() - top)]);
        }
        md += &tf(lang, "nocov", &[&list]);
    }
    if !a.excluded.is_empty() {
        let mut list = a
            .excluded
            .iter()
            .take(top)
            .map(|&i| format!("- {} — {}", nm(i), reason(u[i].excluded().unwrap_or(""))))
            .collect::<Vec<_>>()
            .join("\n");
        if a.excluded.len() > top {
            list += &tf(lang, "more.tests.json", &[&(a.excluded.len() - top)]);
        }
        md += &tf(lang, "excluded", &[&list]);
    }
    if has_dur && !slow.is_empty() {
        md += &tf(lang, "slow", &[&ms(slow_ms)]);
        for &i in slow.iter().take(top) {
            let _ = writeln!(
                md,
                "| {} | {}{} | {} |",
                nmt(i),
                ms(dur(i)),
                if first_in_file[i] { " *" } else { "" },
                a.sizes[i]
            );
        }
        if slow.len() > top {
            line(&mut md, tf(lang, "more.tests", &[&(slow.len() - top)]));
        }
        md += "\n";
    }
    if !no_asr.is_empty() {
        let mut list = no_asr
            .iter()
            .take(top)
            .map(|&i| tf(lang, "noasr.item", &[&nm(i), &a.sizes[i], &a.unique[i]]))
            .collect::<Vec<_>>()
            .join("\n");
        if no_asr.len() > top {
            list += &tf(lang, "more.tests.json", &[&(no_asr.len() - top)]);
        }
        md += &tf(lang, "noasr", &[&list]);
    }
    if !model.fileloads.is_empty() {
        md += &unused_imports_md(model, imp, top, lang);
    }
    if !mo.all_tests {
        md += &tf(lang, "all.omitted", &[&u.len()]);
        return md;
    }
    md += l("all.head");
    if has_dur {
        md += l("all.dur");
    }
    if has_asr {
        md += l("all.asr");
    }
    md += "\n|---|---|---|---|";
    if has_dur {
        md += "---|";
    }
    if has_asr {
        md += "---|";
    }
    md += "\n";
    let mut order: Vec<usize> = (0..u.len()).collect();
    order.sort_by_key(|&i| (excl_set.contains(&i), a.unique[i])); // stable
    for i in order {
        let lines = item_lines(model, &a.unique_items[i]);
        let ex = u[i].excluded();
        let _ = write!(
            md,
            "| {}{} | {} | {} | {} |",
            nmt(i),
            ex.map_or(String::new(), |r| tf(lang, "all.excluded", &[&reason(r)])),
            a.sizes[i],
            if ex.is_some() { "—".to_string() } else { a.unique[i].to_string() },
            if lines.is_empty() { "—".to_string() } else { esc(&lines) }
        );
        if has_dur {
            let _ = write!(md, " {} |", u[i].duration_ms.map_or("—".into(), ms));
        }
        if has_asr {
            let _ = write!(md, " {} |", u[i].assertions.map_or("—".into(), |x| x.to_string()));
        }
        md += "\n";
    }
    md
}

fn unused_imports_md(model: &Model, imp: &Imports, top: usize, lang: Lang) -> String {
    let l = |k: &str| t(lang, k);
    let mut md = String::from(l("imports"));
    if imp.modules.is_empty() {
        md += l("imports.none");
        return md;
    }
    md += l("imports.suspects");
    md += if imp.has_load_ms { l("imports.byload") } else { ".\n\n" };
    md += l("imports.head");
    if imp.has_load_ms {
        md += l("imports.loadcol");
    }
    md += "\n|---|---|---|---|";
    if imp.has_load_ms {
        md += "---|";
    }
    md += "\n";
    for m in imp.modules.iter().take(top) {
        let _ = write!(
            md,
            "| {} | {} | {} | {} |",
            esc(&model.files[m.file as usize]),
            m.loaded_by,
            m.exercised_by,
            if m.no_blocks { l("imports.noblocks") } else { "" }
        );
        if imp.has_load_ms {
            let _ = write!(md, " {} |", m.load_ms_total.map_or("—".into(), ms));
        }
        md += "\n";
    }
    if imp.modules.len() > top {
        md += &tf(lang, "imports.more", &[&(imp.modules.len() - top)]);
        md += "\n";
    }
    md += l("imports.byfile");
    for tfile in imp.test_files.iter().take(top) {
        let list: Vec<String> = tfile
            .unused
            .iter()
            .take(20)
            .map(|(f, lm)| {
                let nb = !model.items.iter().any(|i| i.file == *f);
                format!(
                    "{}{}{}",
                    esc(&model.files[*f as usize]),
                    lm.map_or(String::new(), |x| format!(" ({})", ms(x))),
                    if nb { format!(" ({})", l("imports.noblocks")) } else { String::new() }
                )
            })
            .collect();
        let more = if tfile.unused.len() > 20 { tf(lang, "more.n", &[&(tfile.unused.len() - 20)]) } else { String::new() };
        let _ = writeln!(md, "| {} | {}{more} | {} |", esc(&tfile.test_file), list.join("<br>"), tfile.loaded);
    }
    if imp.test_files.len() > top {
        md += &tf(lang, "more.files", &[&(imp.test_files.len() - top)]);
        md += "\n";
    }
    md += "\n";
    md
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JTest<'a> {
    id: &'a str,
    file: &'a str,
    line: Option<u32>,
    names: &'a [String],
    items: u32,
    unique: u32,
    failed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    excluded: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    assertions: Option<u64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    unique_lines: Vec<String>,
}

#[derive(Serialize)]
struct JGroup<'a> {
    tier: &'a str,
    tests: Vec<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JSub<'a> {
    test: &'a str,
    tier: &'static str,
    by: Vec<&'a str>,
    by_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JNear<'a> {
    a: &'a str,
    b: &'a str,
    jaccard: f64,
    a_group: usize,
    b_group: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JMin {
    size: usize,
    of_tests: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<f64>,
}

#[derive(Serialize)]
struct JExcl<'a> {
    test: &'a str,
    reason: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JReport<'a> {
    generated_at: &'a str,
    format: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    git_head: Option<&'a str>,
    total_items: usize,
    tests: Vec<JTest<'a>>,
    identical: Vec<JGroup<'a>>,
    subsumed: Vec<JSub<'a>>,
    near_duplicates: Vec<JNear<'a>>,
    near_duplicates_total: u64,
    /// statistic only – the concrete greedy choice is not published
    minimal_set: JMin,
    cannot_evaluate: Vec<&'a str>,
    excluded: Vec<JExcl<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unused_imports: Option<JImports<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JModule<'a> {
    module: &'a str,
    loaded_by: usize,
    exercised_by: usize,
    no_blocks: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    load_ms_total: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JUnused<'a> {
    test_file: &'a str,
    loaded: usize,
    unused: Vec<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JImports<'a> {
    modules: Vec<JModule<'a>>,
    test_files: Vec<JUnused<'a>>,
}

pub fn json(model: &Model, a: &Analysis, imp: &Imports, generated: &str) -> String {
    let u = &model.units;
    let id = |i: usize| u[i].id.as_str();
    let has_dur = u.iter().any(|x| x.duration_ms.is_some());
    let r = JReport {
        generated_at: generated,
        format: model.format,
        git_head: model.git_head.as_deref(),
        total_items: a.total_items,
        tests: (0..u.len())
            .map(|i| JTest {
                id: id(i),
                file: &u[i].file,
                line: u[i].line,
                names: &u[i].names,
                items: a.sizes[i],
                unique: a.unique[i],
                failed: u[i].failed,
                excluded: u[i].excluded(),
                duration_ms: u[i].duration_ms,
                assertions: u[i].assertions,
                unique_lines: {
                    let s = item_lines(model, &a.unique_items[i]);
                    if s.is_empty() {
                        vec![]
                    } else {
                        s.split("; ").map(String::from).collect()
                    }
                },
            })
            .collect(),
        identical: a.identical.iter().map(|g| JGroup { tier: &g.tier, tests: g.units.iter().map(|&i| id(i)).collect() }).collect(),
        subsumed: a
            .subsumed
            .iter()
            .map(|s| JSub { test: id(s.unit), tier: "subset", by: s.by.iter().map(|&b| id(b)).collect(), by_count: s.by_count })
            .collect(),
        near_duplicates: a
            .near
            .iter()
            .map(|p| JNear {
                a: id(p.a),
                b: id(p.b),
                jaccard: (p.jaccard * 1000.0).round() / 1000.0,
                a_group: p.a_group,
                b_group: p.b_group,
            })
            .collect(),
        near_duplicates_total: a.near_total,
        minimal_set: JMin {
            size: a.keep.len(),
            of_tests: a.clean - a.no_cov.len(),
            duration_ms: has_dur.then(|| (a.keep.iter().map(|&i| u[i].duration_ms.unwrap_or(0.0)).sum::<f64>() * 1000.0).round() / 1000.0),
        },
        cannot_evaluate: a.no_cov.iter().map(|&i| id(i)).collect(),
        excluded: a.excluded.iter().map(|&i| JExcl { test: id(i), reason: u[i].excluded().unwrap_or("") }).collect(),
        unused_imports: (!model.fileloads.is_empty()).then(|| JImports {
            modules: imp
                .modules
                .iter()
                .map(|m| JModule {
                    module: &model.files[m.file as usize],
                    loaded_by: m.loaded_by,
                    exercised_by: m.exercised_by,
                    no_blocks: m.no_blocks,
                    load_ms_total: m.load_ms_total.map(|x| (x * 1000.0).round() / 1000.0),
                })
                .collect(),
            test_files: imp
                .test_files
                .iter()
                .map(|t| JUnused {
                    test_file: &t.test_file,
                    loaded: t.loaded,
                    unused: t.unused.iter().map(|(f, _)| model.files[*f as usize].as_str()).collect(),
                })
                .collect(),
        }),
    };
    serde_json::to_string_pretty(&r).unwrap()
}
