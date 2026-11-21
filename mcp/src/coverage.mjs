// Line / branch coverage of one source file derived from the v2 block table and per-test hits.
// Line status: the blocks relevant for line L are the innermost block containing L plus every
// block starting on L (branch arms, `&&` operands, nested functions). All hit → covered, some →
// partial, none → uncovered. Lines outside every block (top-level declarations, comments, blank
// lines, lone braces) are not reported.
import { splitLines } from './diff.mjs';

export function lineIndex(blocks) {
  let max = 0;
  for (const b of blocks) if (b[2] > max) max = b[2];
  const innermost = new Int32Array(max + 2).fill(-1);
  const order = blocks.map((b, i) => i).sort((a, b) => span(blocks[b]) - span(blocks[a])); // largest first
  for (const i of order) { const b = blocks[i]; for (let l = b[0]; l <= b[2]; l++) innermost[l] = i; }
  const startsOn = new Map();
  blocks.forEach((b, i) => { const a = startsOn.get(b[0]); a ? a.push(i) : startsOn.set(b[0], [i]); });
  const relevant = (l) => {
    const s = new Set(startsOn.get(l) || []);
    if (l < innermost.length && innermost[l] >= 0) s.add(innermost[l]);
    return [...s];
  };
  return { max, relevant };
}
const span = (b) => (b[2] - b[0]) * 10000 + (b[3] - b[1]);

const SKIP = /^\s*(?:$|\/\/|\/\*|\*|[}\])]+[;,)]*\s*$)/;

/**
 * @param blocks  [[l1,c1,l2,c2,kind]]
 * @param hits    iterable of [testKey, blockIds[]]
 * @param opts    { text?: source at the recorded version (filters blank/comment lines), cap?: ids per line }
 */
export function computeCoverage(blocks, hits, { text, cap = 3, withTests = true } = {}) {
  const n = blocks.length;
  const hitCount = new Uint32Array(n);
  const byBlock = withTests ? Array.from({ length: n }, () => []) : null;
  for (const [key, ids] of hits) for (const id of ids) if (id < n) { hitCount[id]++; if (byBlock) byBlock[id].push(key); }
  const { max, relevant } = lineIndex(blocks);
  const src = text != null ? splitLines(text) : null;
  const covered = [], partial = [], uncovered = [], branches = {}, testsByLine = {}, more = {};
  for (let l = 1; l <= max; l++) {
    const r = relevant(l);
    if (!r.length) continue;
    if (src && SKIP.test(src[l - 1] ?? '')) continue;
    let h = 0;
    for (const i of r) if (hitCount[i]) h++;
    (h === 0 ? uncovered : h === r.length ? covered : partial).push(l);
    const br = r.filter((i) => blocks[i][4] === 'b' && blocks[i][0] === l).sort((a, b) => blocks[a][1] - blocks[b][1]);
    if (br.length) branches[l] = br.map((i) => (hitCount[i] ? 1 : 0));
    if (byBlock && h) {
      const ids = new Set();
      for (const i of r) for (const k of byBlock[i]) ids.add(k);
      const a = [...ids];
      testsByLine[l] = a.slice(0, cap);
      if (a.length > cap) more[l] = a.length - cap;
    }
  }
  return { lines: { covered, partial, uncovered }, branches, ...(withTests ? { testsByLine, more } : {}) };
}

/** Tests hitting a block relevant for line `line`. */
export function testsForLine(blocks, hits, line) {
  const { relevant } = lineIndex(blocks);
  const r = new Set(relevant(line));
  const out = [];
  for (const [key, ids] of hits) if (ids.some((i) => r.has(i))) out.push(key);
  return out;
}
