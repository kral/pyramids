//! Overlap analysis on item sets: identical groups, strict subsets, near-duplicate pairs
//! (prefix-filtered Jaccard join), unique items, lazy greedy set cover.

use crate::model::Model;
use rayon::prelude::*;
use rustc_hash::{FxHashMap, FxHasher};
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::hash::{Hash, Hasher};
use std::time::Instant;

/// Near-duplicate pair between two coverage classes (representatives = first unit of an
/// identical group; `a_group` / `b_group` = number of units with that exact coverage).
#[derive(Debug, Clone)]
pub struct Near {
    pub a: usize,
    pub b: usize,
    pub a_group: usize,
    pub b_group: usize,
    pub jaccard: f64,
    pub a_in_b: f64,
    pub b_in_a: f64,
}

/// Identical-coverage group with a reason tier.
#[derive(Debug, Clone)]
pub struct Group {
    pub units: Vec<usize>,
    /// "same-coverage", "same-coverage+same-assertions", "same-coverage+same-assertions+same-dom", …
    pub tier: String,
}

/// Strict-subset finding for one unit.
#[derive(Debug, Clone, PartialEq)]
pub struct Subsumed {
    pub unit: usize,
    /// smallest supersets (representative units), capped
    pub by: Vec<usize>,
    /// total number of units whose coverage is a strict superset
    pub by_count: usize,
}

#[derive(Debug, Clone)]
pub struct Opts {
    pub threshold: f64,
    pub max_supersets: usize,
    pub max_near_per_test: usize,
    pub max_near_total: usize,
    /// items covered by more than this share of distinct coverage classes ("app shell", shared
    /// setup) are ignored for near-duplicate similarity (only when ≥ 100 classes); 1.0 = off
    pub common_cutoff: f64,
    /// upper bound on verified candidate pairs for near duplicates (bounded run time)
    pub max_near_candidates: u64,
}

impl Default for Opts {
    fn default() -> Self {
        Opts {
            threshold: 0.9,
            max_supersets: 5,
            max_near_per_test: 20,
            max_near_total: 10_000,
            common_cutoff: 0.5,
            max_near_candidates: 10_000_000,
        }
    }
}

#[derive(Debug, Default)]
pub struct Analysis {
    /// number of distinct items covered by at least one test
    pub total_items: usize,
    pub sizes: Vec<u32>,
    pub unique: Vec<u32>,
    /// per unit: model item ids covered only by this unit
    pub unique_items: Vec<Vec<u32>>,
    pub identical: Vec<Group>,
    pub subsumed: Vec<Subsumed>,
    /// capped list (see `near_total`)
    pub near: Vec<Near>,
    /// number of near pairs between coverage classes found before capping
    pub near_total: u64,
    /// greedy set cover over clean units – statistic only, never presented as a list
    pub keep: Vec<usize>,
    /// clean units with empty coverage ("nelze vyhodnotit")
    pub no_cov: Vec<usize>,
    /// units excluded from all verdicts (failed / skipped / tainted / leaky)
    pub excluded: Vec<usize>,
    /// number of clean units
    pub clean: usize,
    pub reps: usize,
    pub candidate_pairs: u64,
    /// items ignored for near-duplicate similarity (covered by > common_cutoff of classes)
    pub common_items: usize,
    /// near-duplicate search stopped at the candidate budget (results incomplete)
    pub near_truncated: bool,
    pub timings: Vec<(&'static str, f64)>,
}

/// Bitset restricted to the word span where it has bits.
struct Bits {
    lo: usize,
    words: Vec<u64>,
}

impl Bits {
    fn from_sorted(ids: &[u32]) -> Bits {
        if ids.is_empty() {
            return Bits { lo: 0, words: vec![] };
        }
        let lo = (ids[0] / 64) as usize;
        let hi = (*ids.last().unwrap() / 64) as usize;
        let mut words = vec![0u64; hi - lo + 1];
        for &i in ids {
            words[i as usize / 64 - lo] |= 1u64 << (i % 64);
        }
        Bits { lo, words }
    }
    #[inline]
    fn hi(&self) -> usize {
        self.lo + self.words.len()
    }
    #[inline]
    fn and_count(&self, o: &Bits) -> u32 {
        let lo = self.lo.max(o.lo);
        let hi = self.hi().min(o.hi());
        if lo >= hi {
            return 0;
        }
        let a = &self.words[lo - self.lo..hi - self.lo];
        let b = &o.words[lo - o.lo..hi - o.lo];
        a.iter().zip(b).map(|(x, y)| (x & y).count_ones()).sum()
    }
    /// self ⊆ o
    #[inline]
    fn subset_of(&self, o: &Bits) -> bool {
        if self.words.is_empty() {
            return true;
        }
        if self.lo < o.lo || self.hi() > o.hi() {
            return false;
        }
        let b = &o.words[self.lo - o.lo..self.hi() - o.lo];
        self.words.iter().zip(b).all(|(x, y)| x & !y == 0)
    }
}

/// Global dense bitset for the greedy cover.
fn gain(b: &Bits, rem: &[u64]) -> u32 {
    b.words.iter().zip(&rem[b.lo..b.hi()]).map(|(x, y)| (x & y).count_ones()).sum()
}

fn intersect_sorted(a: &[u32], b: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(a.len().min(b.len()));
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                out.push(a[i]);
                i += 1;
                j += 1;
            }
        }
    }
    out
}

pub fn analyze(model: &Model, opts: &Opts) -> Analysis {
    let threshold = opts.threshold;
    let mut tm = Vec::new();
    let mut t0 = Instant::now();
    fn lap(name: &'static str, t0: &mut Instant, tm: &mut Vec<(&'static str, f64)>) {
        tm.push((name, t0.elapsed().as_secs_f64() * 1000.0));
        *t0 = Instant::now();
    }
    let units = &model.units;
    let nu = units.len();
    let ni = model.items.len();
    let excl: Vec<bool> = units.iter().map(|u| u.excluded().is_some()).collect();
    let excluded: Vec<usize> = (0..nu).filter(|&u| excl[u]).collect();
    let empty: Vec<u32> = Vec::new();
    // items of clean units only
    let its = |u: usize| -> &Vec<u32> { if excl[u] { &empty } else { &units[u].items } };

    // 1. counts over units, compaction of item ids to covered ones
    let counts: Vec<u32> = (0..nu)
        .into_par_iter()
        .fold(
            || vec![0u32; ni],
            |mut acc, u| {
                for &i in its(u) {
                    acc[i as usize] += 1;
                }
                acc
            },
        )
        .reduce(
            || vec![0u32; ni],
            |mut a, b| {
                for (x, y) in a.iter_mut().zip(b) {
                    *x += y;
                }
                a
            },
        );
    let mut compact = vec![u32::MAX; ni];
    let mut n = 0u32;
    for (i, &c) in counts.iter().enumerate() {
        if c > 0 {
            compact[i] = n;
            n += 1;
        }
    }
    let total_items = n as usize;
    let sizes: Vec<u32> = units.iter().map(|u| u.items.len() as u32).collect();
    let unique_items: Vec<Vec<u32>> =
        (0..nu).into_par_iter().map(|u| its(u).iter().copied().filter(|&i| counts[i as usize] == 1).collect()).collect();
    let unique: Vec<u32> = unique_items.iter().map(|v| v.len() as u32).collect();
    lap("counts+unique", &mut t0, &mut tm);

    // 2. identical groups (hash of the item list; lists are sorted so equal sets ⇔ equal lists)
    let hashes: Vec<u64> = units
        .par_iter()
        .map(|u| {
            let mut h = FxHasher::default();
            u.items.hash(&mut h);
            h.finish()
        })
        .collect();
    let mut by_hash: FxHashMap<u64, Vec<usize>> = FxHashMap::default(); // hash → rep ids
    let mut reps: Vec<usize> = Vec::new(); // rep idx → unit idx
    let mut members: Vec<Vec<usize>> = Vec::new();
    let mut no_cov = Vec::new();
    for ui in 0..nu {
        if excl[ui] {
            continue;
        }
        if units[ui].items.is_empty() {
            no_cov.push(ui);
            continue;
        }
        let cands = by_hash.entry(hashes[ui]).or_default();
        match cands.iter().find(|&&r| units[reps[r]].items == units[ui].items) {
            Some(&r) => members[r].push(ui),
            None => {
                cands.push(reps.len());
                reps.push(ui);
                members.push(vec![ui]);
            }
        }
    }
    let nr = reps.len();
    let identical: Vec<Group> = members
        .iter()
        .filter(|m| m.len() > 1)
        .map(|m| {
            let all_eq = |f: &dyn Fn(&crate::model::Unit) -> &Option<String>| {
                let first = f(&units[m[0]]);
                first.is_some() && m.iter().all(|&u| f(&units[u]) == first)
            };
            // it.each / generated rows on one source line: identical coverage is expected there –
            // the rows differ in data, which coverage cannot see (VALIDATION R2)
            let first = &units[m[0]];
            let parametric = first.line.is_some()
                && m.iter().all(|&u| units[u].file_key() == first.file_key() && units[u].line == first.line);
            let mut tier = String::from(if parametric { "parametric" } else { "same-coverage" });
            if !parametric {
                if all_eq(&|u| &u.assert_hash) {
                    tier += "+same-assertions";
                }
                if all_eq(&|u| &u.dom_hash) {
                    tier += "+same-dom";
                }
            }
            Group { units: m.clone(), tier }
        })
        .collect::<Vec<_>>();
    // strongest reasons first, parametric groups last (stable within a tier)
    let rank = |t: &str| match t {
        "parametric" => 9,
        t => 3 - t.matches('+').count() as i32,
    };
    let mut identical = identical;
    identical.sort_by_key(|g| rank(&g.tier));
    lap("identical", &mut t0, &mut tm);

    // 3. per-rep structures: compact bitsets, rank lists ordered by global frequency
    let rep_items: Vec<Vec<u32>> =
        reps.par_iter().map(|&u| its(u).iter().map(|&i| compact[i as usize]).collect()).collect();
    let bits: Vec<Bits> = rep_items.par_iter().map(|v| Bits::from_sorted(v)).collect();
    let rsize: Vec<u32> = rep_items.iter().map(|v| v.len() as u32).collect();
    let mut freq = vec![0u32; total_items];
    for v in &rep_items {
        for &i in v {
            freq[i as usize] += 1;
        }
    }
    let mut order: Vec<u32> = (0..total_items as u32).collect();
    order.par_sort_unstable_by_key(|&i| (freq[i as usize], i));
    let mut rank = vec![0u32; total_items];
    for (r, &i) in order.iter().enumerate() {
        rank[i as usize] = r as u32;
    }
    let ranks: Vec<Vec<u32>> = rep_items
        .into_par_iter()
        .map(|v| {
            let mut r: Vec<u32> = v.into_iter().map(|i| rank[i as usize]).collect();
            r.sort_unstable();
            r
        })
        .collect();
    // full postings (CSR) over ranks
    let mut post_off = vec![0u32; total_items + 1];
    for (r, &i) in order.iter().enumerate() {
        post_off[r + 1] = post_off[r] + freq[i as usize];
    }
    let mut post = vec![0u32; post_off[total_items] as usize];
    let mut fill = post_off.clone();
    for (ri, rl) in ranks.iter().enumerate() {
        for &r in rl {
            post[fill[r as usize] as usize] = ri as u32;
            fill[r as usize] += 1;
        }
    }
    let postings = |r: u32| &post[post_off[r as usize] as usize..post_off[r as usize + 1] as usize];
    lap("index", &mut t0, &mut tm);

    // 4. strict subsets: A ⊂ B ⇒ B contains A's rarest items
    let sub_rep: Vec<Vec<u32>> = (0..nr)
        .into_par_iter()
        .map(|a| {
            let rl = &ranks[a];
            let mut cand: Vec<u32> = postings(rl[0]).to_vec();
            let mut k = 1;
            while cand.len() > 32 && k < rl.len() && k < 4 {
                cand = intersect_sorted(&cand, postings(rl[k]));
                k += 1;
            }
            let out: Vec<u32> = cand
                .into_iter()
                .filter(|&b| {
                    let b = b as usize;
                    rsize[b] > rsize[a] && bits[a].subset_of(&bits[b])
                })
                .collect();
                        out
        })
        .collect();
    let mut subsumed = Vec::new();
    for a in 0..nr {
        if sub_rep[a].is_empty() {
            continue;
        }
        let by_count: usize = sub_rep[a].iter().map(|&b| members[b as usize].len()).sum();
        let mut by: Vec<usize> = sub_rep[a].iter().map(|&b| reps[b as usize]).collect();
        by.sort_by_key(|&b| (sizes[b], b));
        by.truncate(opts.max_supersets.max(1));
        for &u in &members[a] {
            subsumed.push(Subsumed { unit: u, by: by.clone(), by_count });
        }
    }
    subsumed.sort_by_key(|s| s.unit);
    lap("subsumed", &mut t0, &mut tm);

    // 5. near duplicates: prefix filtering (AllPairs). J ≥ t ⇒ |A∩B| ≥ ⌈t·|X|⌉ for both sets,
    // so the prefixes of length |X| − ⌈t·|X|⌉ + 1 (rarest items first) must intersect.
    let t = threshold.clamp(0.0, 1.0);
    let eps = 1e-9;
    // common ("shell") items are a suffix of the frequency order → cut every rank list there
    let r0 = if opts.common_cutoff < 1.0 && nr >= 100 {
        let lim = opts.common_cutoff * nr as f64;
        order.partition_point(|&i| (freq[i as usize] as f64) <= lim)
    } else {
        total_items
    } as u32;
    let common_items = total_items - r0 as usize;
    let nlen: Vec<usize> = ranks.iter().map(|rl| rl.partition_point(|&r| r < r0)).collect();
    let nsize: Vec<u32> = nlen.iter().map(|&x| x as u32).collect();
    let nbits_store: Vec<Bits> = if common_items > 0 {
        ranks
            .par_iter()
            .zip(&nlen)
            .map(|(rl, &n)| {
                let mut v: Vec<u32> = rl[..n].iter().map(|&r| order[r as usize]).collect();
                v.sort_unstable();
                Bits::from_sorted(&v)
            })
            .collect()
    } else {
        Vec::new()
    };
    let nbits: &Vec<Bits> = if common_items > 0 { &nbits_store } else { &bits };
    let budget = std::sync::atomic::AtomicU64::new(0);
    let truncated = std::sync::atomic::AtomicBool::new(false);
    let plen = |s: u32| -> usize {
        let need = ((t * s as f64) - eps).ceil().max(1.0) as u32;
        (s - need.min(s) + 1).min(s) as usize
    };
    let mut pidx_off = vec![0u32; total_items + 1];
    for (ri, rl) in ranks.iter().enumerate() {
        for &r in &rl[..plen(nsize[ri])] {
            pidx_off[r as usize + 1] += 1;
        }
    }
    for r in 0..total_items {
        pidx_off[r + 1] += pidx_off[r];
    }
    let mut pidx = vec![0u32; pidx_off[total_items] as usize];
    let mut fill = pidx_off.clone();
    for (ri, rl) in ranks.iter().enumerate() {
        for &r in &rl[..plen(nsize[ri])] {
            pidx[fill[r as usize] as usize] = ri as u32;
            fill[r as usize] += 1;
        }
    }
    let near_res: Vec<(Vec<(u32, u32, u32)>, u64, u64)> = (0..nr)
        .into_par_iter()
        .map_init(
            || vec![u32::MAX; nr],
            |stamp, a| {
                let sa = nsize[a];
                if truncated.load(std::sync::atomic::Ordering::Relaxed) {
                    return (Vec::new(), 0, 0);
                }
                let minb = t * sa as f64 - eps;
                let mut out = Vec::new();
                let mut cands = 0u64;
                for &r in &ranks[a][..plen(sa)] {
                    for &b in &pidx[pidx_off[r as usize] as usize..pidx_off[r as usize + 1] as usize] {
                        let bu = b as usize;
                        let sb = nsize[bu];
                        if !(sb < sa || (sb == sa && bu < a)) || (sb as f64) < minb || stamp[bu] == a as u32 {
                            continue;
                        }
                        stamp[bu] = a as u32;
                        cands += 1;
                        let inter = nbits[a].and_count(&nbits[bu]);
                        if inter == 0 {
                            continue;
                        }
                        let j = inter as f64 / (sa + sb - inter) as f64;
                        if j >= t - eps && (inter < sa.max(sb) || common_items > 0) {
                            out.push((a as u32, b, inter));
                        }
                    }
                }
                if budget.fetch_add(cands, std::sync::atomic::Ordering::Relaxed) + cands > opts.max_near_candidates {
                    truncated.store(true, std::sync::atomic::Ordering::Relaxed);
                }
                let found = out.len() as u64;
                if out.len() > opts.max_near_per_test {
                    // keep the most similar pairs of this probe (bounded output)
                    let key = |&(a, b, i): &(u32, u32, u32)| {
                        let (sa, sb) = (nsize[a as usize] as f64, nsize[b as usize] as f64);
                        i as f64 / (sa + sb - i as f64)
                    };
                    out.sort_by(|x, y| key(y).partial_cmp(&key(x)).unwrap().then(x.1.cmp(&y.1)));
                    out.truncate(opts.max_near_per_test);
                }
                (out, cands, found)
            },
        )
        .collect();
    let candidate_pairs: u64 = near_res.iter().map(|x| x.1).sum();
    let near_total: u64 = near_res.iter().map(|x| x.2).sum();
    let mut near = Vec::new();
    for (v, _, _) in &near_res {
        for &(ra, rb, inter) in v {
            let (sa, sb) = (nsize[ra as usize] as f64, nsize[rb as usize] as f64);
            let j = inter as f64 / (sa + sb - inter as f64);
            let (ua, ub) = (reps[ra as usize], reps[rb as usize]);
            let (a, b, ia, ib, ga, gb) = if ua < ub {
                (ua, ub, sa, sb, members[ra as usize].len(), members[rb as usize].len())
            } else {
                (ub, ua, sb, sa, members[rb as usize].len(), members[ra as usize].len())
            };
            near.push(Near { a, b, a_group: ga, b_group: gb, jaccard: j, a_in_b: inter as f64 / ia, b_in_a: inter as f64 / ib });
        }
    }
    near.par_sort_unstable_by(|x, y| y.jaccard.partial_cmp(&x.jaccard).unwrap().then(x.a.cmp(&y.a)).then(x.b.cmp(&y.b)));
    near.truncate(opts.max_near_total);
    lap("near", &mut t0, &mut tm);

    // 6. lazy greedy set cover over reps (ties → lowest unit index, like the Node version)
    let words = total_items.div_ceil(64);
    let mut rem = vec![!0u64; words];
    if total_items % 64 != 0 {
        rem[words - 1] = (1u64 << (total_items % 64)) - 1;
    }
    let mut left = total_items;
    let mut heap: BinaryHeap<(u32, Reverse<usize>, usize)> = (0..nr).map(|r| (rsize[r], Reverse(reps[r]), r)).collect();
    let mut keep_r = Vec::new();
    while left > 0 {
        let Some((_, ord, r)) = heap.pop() else { break };
        let g = gain(&bits[r], &rem);
        if g == 0 {
            continue;
        }
        let fresh = (g, ord, r);
        if heap.peek().is_none_or(|top| fresh >= *top) {
            keep_r.push(r);
            let b = &bits[r];
            for (w, x) in rem[b.lo..b.hi()].iter_mut().zip(&b.words) {
                *w &= !x;
            }
            left -= g as usize;
        } else {
            heap.push(fresh);
        }
    }
    let keep: Vec<usize> = keep_r.iter().map(|&r| reps[r]).collect();
    lap("setcover", &mut t0, &mut tm);

    Analysis {
        total_items,
        sizes,
        unique,
        unique_items,
        identical,
        subsumed,
        near,
        keep,
        no_cov,
        excluded: excluded.clone(),
        clean: nu - excluded.len(),
        near_total,
        common_items,
        near_truncated: truncated.load(std::sync::atomic::Ordering::Relaxed),
        reps: nr,
        candidate_pairs,
        timings: tm,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Item, Unit};

    fn model(sets: &[&[u32]]) -> Model {
        let n = sets.iter().flat_map(|s| s.iter()).max().map_or(0, |m| m + 1);
        Model {
            files: vec!["f".into()],
            items: (0..n).map(|i| Item { file: 0, lines: vec![i + 1], span: (i + 1, i + 1) }).collect(),
            units: sets
                .iter()
                .enumerate()
                .map(|(i, s)| Unit { id: format!("t:{i}"), names: vec![format!("t{i}")], items: s.to_vec(), ..Default::default() })
                .collect(),
            ..Default::default()
        }
    }

    /// brute-force reference
    fn brute(sets: &[&[u32]], t: f64) -> (Vec<(usize, Vec<usize>)>, Vec<(usize, usize)>) {
        use std::collections::BTreeSet;
        let s: Vec<BTreeSet<u32>> = sets.iter().map(|x| x.iter().copied().collect()).collect();
        let mut sub = vec![];
        for a in 0..s.len() {
            if s[a].is_empty() {
                continue;
            }
            let mut by: Vec<usize> = (0..s.len()).filter(|&b| s[b].len() > s[a].len() && s[a].is_subset(&s[b])).collect();
            by.sort_by_key(|&b| (s[b].len(), b));
            if !by.is_empty() {
                sub.push((a, by));
            }
        }
        let mut near = vec![];
        for a in 0..s.len() {
            for b in a + 1..s.len() {
                let i = s[a].intersection(&s[b]).count();
                if i == 0 {
                    continue;
                }
                let j = i as f64 / (s[a].len() + s[b].len() - i) as f64;
                if j >= t && j < 1.0 {
                    near.push((a, b));
                }
            }
        }
        near.sort();
        (sub, near)
    }

    #[test]
    fn matches_bruteforce_random() {
        let mut seed = 12345u64;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for round in 0..30 {
            let n_items = 20 + (round * 7) as u32;
            let mut sets: Vec<Vec<u32>> = Vec::new();
            for k in 0..40 {
                if k > 0 && rnd() % 4 == 0 {
                    // mutate a previous set → near dupes / subsets / identical
                    let mut s = sets[(rnd() % k as u64) as usize].clone();
                    match rnd() % 3 {
                        0 => {
                            s.pop();
                        }
                        1 => s.push((rnd() % n_items as u64) as u32),
                        _ => {}
                    }
                    s.sort();
                    s.dedup();
                    sets.push(s);
                } else {
                    let mut s: Vec<u32> = (0..(rnd() % 15)).map(|_| (rnd() % n_items as u64) as u32).collect();
                    s.sort();
                    s.dedup();
                    sets.push(s);
                }
            }
            let refs: Vec<&[u32]> = sets.iter().map(|s| s.as_slice()).collect();
            for &t in &[0.5, 0.8, 0.9] {
                let m = model(&refs);
                let opts = Opts { threshold: t, max_supersets: 1000, max_near_per_test: 1_000_000, max_near_total: 1_000_000, ..Default::default() };
                let an = analyze(&m, &opts);
                let (sub, near) = brute(&refs, t);
                assert_eq!(an.subsumed.len(), sub.len(), "round {round} t {t}");
                for (s, (u, by)) in an.subsumed.iter().zip(&sub) {
                    assert_eq!(s.unit, *u);
                    assert_eq!(s.by_count, by.len());
                    assert!(s.by.iter().all(|b| by.contains(b)));
                }
                // expand representative pairs to all members of identical groups
                let group_of = |u: usize| -> Vec<usize> {
                    an.identical.iter().find(|g| g.units[0] == u).map_or(vec![u], |g| g.units.clone())
                };
                let mut got: Vec<(usize, usize)> = an
                    .near
                    .iter()
                    .flat_map(|p| {
                        let (ga, gb) = (group_of(p.a), group_of(p.b));
                        ga.iter().flat_map(|&x| gb.iter().map(move |&y| (x.min(y), x.max(y)))).collect::<Vec<_>>()
                    })
                    .collect();
                got.sort();
                assert_eq!(got, near, "round {round} t {t}");
                // set cover covers everything
                let mut cov = std::collections::BTreeSet::new();
                for &k in &an.keep {
                    cov.extend(sets[k].iter().copied());
                }
                assert_eq!(cov.len(), an.total_items);
            }
        }
    }

    #[test]
    fn groups_unique_cover() {
        let m = model(&[&[0, 1, 2], &[0, 1, 2], &[0, 1, 2, 3], &[4], &[]]);
        let a = analyze(&m, &Opts { threshold: 0.7, ..Default::default() });
        assert_eq!(a.identical.len(), 1);
        assert_eq!(a.identical[0].units, vec![0, 1]);
        assert_eq!(a.identical[0].tier, "same-coverage");
        assert_eq!(a.subsumed[0], Subsumed { unit: 0, by: vec![2], by_count: 1 });
        assert_eq!(a.subsumed[1], Subsumed { unit: 1, by: vec![2], by_count: 1 });
        assert_eq!(a.unique, vec![0, 0, 1, 1, 0]);
        assert_eq!(a.keep, vec![2, 3]);
        assert_eq!(a.no_cov, vec![4]);
        assert_eq!(a.near.len(), 1); // classes {0,1} – {2}, J = 0.75
        assert_eq!((a.near[0].a, a.near[0].a_group), (0, 2));
    }

    #[test]
    fn parametric_groups_rank_last() {
        let mut m = model(&[&[0, 1], &[0, 1], &[2, 3], &[2, 3]]);
        for (i, u) in m.units.iter_mut().enumerate() {
            u.line = Some(if i < 2 { 7 } else { 10 + i as u32 });
            u.key = ("t.test.ts".into(), u.line.unwrap(), u.names[0].clone());
        }
        let a = analyze(&m, &Opts::default());
        assert_eq!(a.identical.len(), 2);
        assert_eq!(a.identical[0].units, vec![2, 3]);
        assert_eq!(a.identical[0].tier, "same-coverage");
        assert_eq!(a.identical[1].units, vec![0, 1]);
        assert_eq!(a.identical[1].tier, "parametric");
    }

    #[test]
    fn excluded_units_do_not_count() {
        let mut m = model(&[&[0, 1], &[0, 1], &[0, 1, 2]]);
        m.units[2].failed = true;
        let a = analyze(&m, &Opts::default());
        assert_eq!(a.excluded, vec![2]);
        assert_eq!(a.total_items, 2);
        assert!(a.subsumed.is_empty());
        assert_eq!(a.identical.len(), 1);
        m.units[1].tainted = true;
        let a = analyze(&m, &Opts::default());
        assert!(a.identical.is_empty());
        assert_eq!(a.unique, vec![2, 0, 0]);
    }
}
