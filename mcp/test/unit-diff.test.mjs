import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, lineMapper, splitLines } from '../src/diff.mjs';

function apply(a, hunks, b) {
  const A = splitLines(a), B = splitLines(b), out = [];
  let ai = 0;
  for (const h of hunks) {
    const upto = h.oldLen ? h.oldStart - 1 : h.oldStart;
    while (ai < upto) out.push(A[ai++]);
    ai += h.oldLen;
    for (let i = 0; i < h.newLen; i++) out.push(B[h.newStart - 1 + i]);
  }
  while (ai < A.length) out.push(A[ai++]);
  return out;
}

test('diffLines: random edits reproduce the new text and lineMapper maps unchanged lines', () => {
  let seed = 3; const r = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let t = 0; t < 500; t++) {
    const A = Array.from({ length: Math.floor(r() * 50) }, () => 'l' + Math.floor(r() * 6));
    const B = A.slice();
    for (let j = Math.floor(r() * 6); j > 0; j--) { const p = Math.floor(r() * (B.length + 1)); const o = r(); if (o < 0.33) B.splice(p, 0, 'n' + j); else if (o < 0.66) B.splice(p, 1); else B[p] = 'x' + j; }
    const a = A.join('\n') + '\n', b = B.join('\n') + '\n';
    const h = diffLines(a, b);
    assert.deepEqual(apply(a, h, b), splitLines(b), `case ${t}`);
    const { map } = lineMapper(h);
    for (let i = 1; i <= A.length; i++) { const m = map(i); if (m != null) assert.equal(B[m - 1], A[i - 1]); }
  }
});

test('diffLines: identical and empty inputs', () => {
  assert.deepEqual(diffLines('a\nb\n', 'a\nb\n'), []);
  assert.deepEqual(diffLines('', 'x\n'), [{ oldStart: 0, oldLen: 0, newStart: 1, newLen: 1 }]);
  assert.deepEqual(diffLines('x\n', ''), [{ oldStart: 1, oldLen: 1, newStart: 0, newLen: 0 }]);
});

test('lineMapper.cleanSpan: insertion strictly inside a span is not clean, at its edge it is', () => {
  const { cleanSpan } = lineMapper(diffLines('a\nb\nc\nd\n', 'a\nb\nX\nc\nd\n')); // insert after old line 2
  assert.equal(cleanSpan(1, 3), false);
  assert.equal(cleanSpan(3, 4), true);
  assert.equal(cleanSpan(1, 2), true);
});
