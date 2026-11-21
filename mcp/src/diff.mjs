// Line diff (Myers O(ND), common prefix/suffix trimmed) → git-style -U0 hunks and unified diff text.
// Used to diff the version a file had when the map was recorded (.vto/blobs) against the working
// tree – no git needed – and to remap block positions of tests that did not re-run.

/** @returns {{oldStart:number, oldLen:number, newStart:number, newLen:number}[]} git -U0 numbering */
export function diffLines(a, b, { maxD = 2000 } = {}) {
  const A = typeof a === 'string' ? splitLines(a) : a;
  const B = typeof b === 'string' ? splitLines(b) : b;
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf), b2 = B.slice(pre, B.length - suf);
  const ops = myers(a2, b2, maxD); // [[type, aIdx, bIdx]] type: '=', '-', '+'
  // group into hunks
  const hunks = [];
  let i = 0, ai = 0, bi = 0;
  while (i < ops.length) {
    if (ops[i] === '=') { ai++; bi++; i++; continue; }
    const h = { a0: ai, b0: bi, del: 0, ins: 0 };
    while (i < ops.length && ops[i] !== '=') { if (ops[i] === '-') { h.del++; ai++; } else { h.ins++; bi++; } i++; }
    hunks.push(h);
  }
  return hunks.map((h) => ({
    oldStart: h.del ? pre + h.a0 + 1 : pre + h.a0, oldLen: h.del,
    newStart: h.ins ? pre + h.b0 + 1 : pre + h.b0, newLen: h.ins,
  }));
}

export function splitLines(s) {
  if (s === '') return [];
  const l = s.split('\n');
  if (l[l.length - 1] === '') l.pop();
  return l;
}

/** Edit script as an array of '=', '-', '+' (Myers, linear space not needed for source files). */
function myers(a, b, maxD) {
  const n = a.length, m = b.length;
  if (!n) return Array(m).fill('+');
  if (!m) return Array(n).fill('-');
  const max = n + m, off = max;
  let v = new Int32Array(2 * max + 2);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    if (d > maxD) return [...Array(n).fill('-'), ...Array(m).fill('+')]; // too different: one big replace (conservative)
    trace.push({ base: off - d - 1, arr: v.slice(Math.max(0, off - d - 1), off + d + 2) });
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, v, d, n, m, off);
    }
  }
  return [];
}
function backtrack(trace, vLast, dEnd, n, m, off) {
  const ops = [];
  let x = n, y = m;
  for (let d = dEnd; d > 0; d--) {
    const t = trace[d];
    const g = (i) => t.arr[i - Math.max(0, t.base)];
    const k = x - y;
    const prevK = (k === -d || (k !== d && g(off + k - 1) < g(off + k + 1))) ? k + 1 : k - 1;
    const px = g(off + prevK), py = px - prevK;
    while (x > px && y > py) { ops.push('='); x--; y--; }
    if (x === px) { ops.push('+'); y--; } else { ops.push('-'); x--; }
  }
  while (x > 0 && y > 0) { ops.push('='); x--; y--; }
  return ops.reverse();
}

/** Unified diff text (-U0) for one file, paths relative with forward slashes. */
export function unifiedDiff(relOld, relNew, oldText, newText, hunks = diffLines(oldText, newText)) {
  if (!hunks.length && relOld === relNew) return '';
  const A = splitLines(oldText ?? ''), B = splitLines(newText ?? '');
  let out = `diff --git a/${relOld ?? relNew} b/${relNew ?? relOld}\n`;
  out += oldText == null ? '--- /dev/null\n' : `--- a/${relOld}\n`;
  out += newText == null ? '+++ /dev/null\n' : `+++ b/${relNew}\n`;
  for (const h of hunks) {
    out += `@@ -${h.oldStart}${h.oldLen === 1 ? '' : ',' + h.oldLen} +${h.newStart}${h.newLen === 1 ? '' : ',' + h.newLen} @@\n`;
    for (let i = 0; i < h.oldLen; i++) out += `-${A[h.oldStart - 1 + i]}\n`;
    for (let i = 0; i < h.newLen; i++) out += `+${B[h.newStart - 1 + i]}\n`;
  }
  return out;
}

/**
 * old line → new line for unchanged lines (null for changed/deleted).
 * `cleanSpan(l1, l2)`: true when no hunk touches old lines l1..l2 and nothing was inserted
 * strictly inside the span (after old line p with l1 <= p < l2).
 */
export function lineMapper(hunks) {
  const hs = hunks.map((h) => ({ ...h, aEnd: h.oldLen ? h.oldStart + h.oldLen - 1 : h.oldStart }));
  const map = (line) => {
    let shift = 0;
    for (const h of hs) {
      if (h.oldLen) {
        if (line < h.oldStart) break;
        if (line <= h.aEnd) return null;
      } else if (line <= h.oldStart) break; // insertion after old line oldStart
      shift += h.newLen - h.oldLen;
    }
    return line + shift;
  };
  const cleanSpan = (l1, l2) => {
    for (const h of hs) {
      if (h.oldLen) { if (h.oldStart <= l2 && h.aEnd >= l1) return false; }
      else if (h.oldStart >= l1 && h.oldStart < l2) return false;
    }
    return true;
  };
  /** new-side changed lines (for "lines changed since …" questions) */
  return { map, cleanSpan };
}

/** Changed / inserted line numbers on the NEW side (1-based). */
export function newSideLines(hunks) {
  const out = [];
  for (const h of hunks) for (let i = 0; i < h.newLen; i++) out.push(h.newStart + i);
  return out;
}
