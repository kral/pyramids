//! Flattening of V8 precise-coverage ranges into covered intervals.
//!
//! Each function contributes a list of `(start, end, count)` ranges; the first one is the
//! function itself, the rest are nested blocks. Ranges of all functions nest into one tree.
//! The effective count at an offset is the count of the innermost range containing it.

/// A half-open interval `[start, end)` in UTF-16 code units.
pub type Interval = (u32, u32);

/// Result of flattening one script's coverage for one test.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Flat {
    /// Sorted, non-overlapping, non-adjacent intervals with effective count > 0.
    pub covered: Vec<Interval>,
    /// Zero-count ranges whose direct parent range has count > 0 (= a branch / block /
    /// closure that was *not* executed although the surrounding code was).
    /// Sorted by start, may nest only if V8 reported nested zero ranges under a positive one
    /// (it doesn't), clipped to the parent.
    pub skipped: Vec<Interval>,
}

#[inline]
fn emit(out: &mut Vec<Interval>, a: u32, b: u32, count: u64) {
    if a >= b || count == 0 {
        return;
    }
    if let Some(last) = out.last_mut() {
        if last.1 >= a {
            if b > last.1 {
                last.1 = b;
            }
            return;
        }
    }
    out.push((a, b));
}

/// Flattens ranges of all functions of one script. `ranges` is consumed (re-sorted).
pub fn flatten(mut ranges: Vec<(u32, u32, u64)>) -> Flat {
    let mut flat = Flat::default();
    if ranges.is_empty() {
        return flat;
    }
    // start asc, end desc; stable so that for identical ranges the later one (a nested block
    // that repeats its parent's span) ends up on top of the stack and wins.
    ranges.sort_by(|x, y| x.0.cmp(&y.0).then(y.1.cmp(&x.1)));
    let mut stack: Vec<(u32, u64)> = Vec::with_capacity(16); // (end, count)
    let mut cur: u32 = 0;
    for &(s, e, c) in &ranges {
        if e <= s {
            continue;
        }
        while let Some(&(te, tc)) = stack.last() {
            if te <= s {
                emit(&mut flat.covered, cur, te, tc);
                cur = cur.max(te);
                stack.pop();
            } else {
                break;
            }
        }
        let mut e = e;
        if let Some(&(te, tc)) = stack.last() {
            emit(&mut flat.covered, cur, s, tc);
            if e > te {
                e = te; // malformed (crossing) range: clip to parent
            }
            if c == 0 && tc > 0 {
                flat.skipped.push((s, e));
            }
        }
        cur = s;
        stack.push((e, c));
    }
    while let Some((te, tc)) = stack.pop() {
        emit(&mut flat.covered, cur, te, tc);
        cur = cur.max(te);
    }
    flat
}

/// Convenience: flatten V8 `functions` arrays as they appear in the raw file.
pub fn flatten_functions(functions: &[Vec<(u32, u32, u64)>]) -> Flat {
    let n: usize = functions.iter().map(|f| f.len()).sum();
    let mut all = Vec::with_capacity(n);
    for f in functions {
        all.extend_from_slice(f);
    }
    flatten(all)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(fns: &[&[(u32, u32, u64)]]) -> Flat {
        flatten_functions(&fns.iter().map(|x| x.to_vec()).collect::<Vec<_>>())
    }

    #[test]
    fn single_function() {
        let r = f(&[&[(10, 20, 1)]]);
        assert_eq!(r.covered, vec![(10, 20)]);
        assert!(r.skipped.is_empty());
    }

    #[test]
    fn nested_zero_block_splits() {
        let r = f(&[&[(0, 100, 3), (10, 20, 0), (50, 60, 0)]]);
        assert_eq!(r.covered, vec![(0, 10), (20, 50), (60, 100)]);
        assert_eq!(r.skipped, vec![(10, 20), (50, 60)]);
    }

    #[test]
    fn innermost_wins_deep_nesting() {
        // fn 1 > block 0 > inner block 2 (e.g. loop body re-entered – unusual but legal)
        let r = f(&[&[(0, 100, 1), (10, 90, 0), (40, 50, 2)]]);
        assert_eq!(r.covered, vec![(0, 10), (40, 50), (90, 100)]);
        assert_eq!(r.skipped, vec![(10, 90)]); // (40,50) has a zero parent → not a skip
    }

    #[test]
    fn separate_functions_nest_across_entries() {
        // outer function covered, inner closure (separate entry) never called
        let r = f(&[&[(0, 100, 1)], &[(30, 60, 0)]]);
        assert_eq!(r.covered, vec![(0, 30), (60, 100)]);
        assert_eq!(r.skipped, vec![(30, 60)]);
        // order of function entries must not matter
        let r2 = f(&[&[(30, 60, 0)], &[(0, 100, 1)]]);
        assert_eq!(r, r2);
    }

    #[test]
    fn uncalled_top_level_function_is_not_a_skip() {
        let r = f(&[&[(0, 10, 0)], &[(20, 30, 1)]]);
        assert_eq!(r.covered, vec![(20, 30)]);
        assert!(r.skipped.is_empty());
    }

    #[test]
    fn adjacent_intervals_merge() {
        let r = f(&[&[(0, 10, 1)], &[(10, 20, 1)], &[(20, 30, 0)], &[(30, 40, 2)]]);
        assert_eq!(r.covered, vec![(0, 20), (30, 40)]);
    }

    #[test]
    fn identical_range_later_wins() {
        let r = f(&[&[(0, 10, 1), (0, 10, 0)]]);
        assert!(r.covered.is_empty());
        let r = f(&[&[(0, 10, 0), (0, 10, 4)]]);
        assert_eq!(r.covered, vec![(0, 10)]);
    }

    #[test]
    fn sample_price_vip() {
        // from samples/demo-raw "vip bulk"
        let r = f(&[&[(242, 281, 1), (271, 279, 0)], &[(361, 558, 1), (417, 440, 0)]]);
        assert_eq!(r.covered, vec![(242, 271), (279, 281), (361, 417), (440, 558)]);
        assert_eq!(r.skipped, vec![(271, 279), (417, 440)]);
    }

    #[test]
    fn empty_and_degenerate() {
        assert_eq!(f(&[]), Flat::default());
        assert_eq!(f(&[&[(5, 5, 1)]]), Flat::default());
    }
}
