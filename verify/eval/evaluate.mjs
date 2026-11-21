#!/usr/bin/env node
// Precision / recall of redundancy verdicts per signal tier against a hand-labelled ground truth.
//   node evaluate.mjs --gt GROUND_TRUTH.json --report report.json --verify verify.json --raw RAWDIR --root DIR
//                     [--write-survivors FILE --survivors-tier NAME] [--json OUT]
// Positive class = "A is redundant given B" for an ordered candidate pair (A, B).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { staticFeatures, staticSubset } from '../static-features.mjs';

const a = process.argv.slice(2);
const o = {};
for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, '')] = a[i + 1];
const root = path.resolve(o.root || '.');
const gt = JSON.parse(readFileSync(o.gt, 'utf8'));
const verify = JSON.parse(readFileSync(o.verify, 'utf8'));
const gtRed = new Map(gt.redundantPairs.map(([x, y, kind]) => [`${x}\u0000${y}`, kind]));
const toKey = (uid) => uid.replace(/^(.*?):\d+ > /, '$1 > ');

// signals (s-*.jsonl written by signals-setup.mjs)
const sig = new Map();
let sigUs = 0, sigN = 0;
for (const f of readdirSync(o.raw)) if (/^s-.*\.jsonl$/.test(f)) for (const line of readFileSync(path.join(o.raw, f), 'utf8').split('\n')) {
  if (!line) continue;
  const r = JSON.parse(line);
  sig.set(`${path.relative(root, r.file)} > ${r.name}`, r);
  sigUs += r.us; sigN++;
}
// static features
const stat = new Map();
const t0 = performance.now();
const files = new Set(Object.keys(gt.tests).map((k) => k.split(' > ')[0]));
for (const f of files) for (const [name, feat] of staticFeatures(path.join(root, f))) stat.set(`${f} > ${name}`, feat);
const staticMs = performance.now() - t0;

const pairs = [];
for (const c of verify.candidates) for (const p of c.pairs) {
  const A = toKey(p.a), B = toKey(p.b);
  const sa = sig.get(A), sb = sig.get(B), fa = stat.get(A), fb = stat.get(B);
  const truth = gtRed.has(`${A}\u0000${B}`);
  const assertSub = sa && sb ? sa.asserts.every((x) => sb.asserts.includes(x)) : true;
  const domEq = sa && sb ? sa.dom === sb.dom : true;
  const stOk = fa && fb ? staticSubset(fa, fb) : true;
  const V = { 'potvrzeno redundantní': 'confirmed', 'nelze ověřit': 'unverifiable', 'liší se asercemi': 'differs' };
  const v = V[p.verdict] ?? p.verdict;
  const mutOk = v === 'confirmed';
  const mutNR = v === 'not-refuted';
  const mutNA = v === 'unverifiable';
  pairs.push({ a: p.a, b: p.b, A, B, type: c.type, truth, kind: gtRed.get(`${A}\u0000${B}`) ?? null, verdict: p.verdict, reason: p.reason,
    onlyA: p.onlyA?.map((m) => `${m.file}:${m.line} ${m.desc}`),
    pred: {
      'coverage': true,
      'coverage+static': stOk,
      'coverage+dom': domEq,
      'coverage+assert': assertSub,
      'coverage+assert+dom': assertSub && domEq,
      'coverage+static+assert': stOk && assertSub,
      'coverage+mutation (confirmed)': mutOk,
      'coverage+mutation (confirmed ∪ not refuted)': mutOk || mutNR,
      'coverage+mutation (all but differs)': mutOk || mutNR || mutNA,
      'coverage+dom → mutation': domEq && mutOk,
      'coverage+assert → mutation': assertSub && mutOk,
      'coverage+assert+dom → mutation': assertSub && domEq && mutOk,
    } });
}
const tiers = Object.keys(pairs[0].pred);
const pct = (x) => (x * 100).toFixed(1) + ' %';
const sameFile = (p) => p.A.split(' > ')[0] === p.B.split(' > ')[0];
function table(title, ps) {
  const pos = ps.filter((p) => p.truth).length;
  console.log(`\n### ${title}: ${ps.length} ordered candidate pairs, ${pos} truly redundant (GT has ${totalPos})`);
  console.log('| tier | predicted redundant | TP | FP | precision | recall (all GT pairs) |');
  console.log('|---|---|---|---|---|---|');
  const rows = tiers.map((tier) => {
    let tp = 0, fp = 0;
    for (const p of ps) if (p.pred[tier]) { if (p.truth) tp++; else fp++; }
    return { tier, predicted: tp + fp, tp, fp, precision: tp / Math.max(1, tp + fp), recall: tp / totalPos };
  });
  for (const r of rows) console.log(`| ${r.tier} | ${r.predicted} | ${r.tp} | ${r.fp} | ${pct(r.precision)} | ${pct(r.recall)} |`);
  return rows;
}
const totalPos = gtRed.size;
console.log(`signals overhead (in-worker, measured): ${(sigUs / Math.max(1, sigN) / 1000).toFixed(3)} ms/test over ${sigN} tests; static features: ${staticMs.toFixed(0)} ms for ${files.size} files`);
const rows = table('same-file pairs (fully labelled)', pairs.filter(sameFile));
const rowsAll = table('all pairs (cross-file pairs count as NOT redundant – GT labels only same-file redundancy)', pairs);
const cross = pairs.filter((p) => !sameFile(p));
console.log(`cross-file pairs: ${cross.length}, mutation verdicts: ${JSON.stringify(cross.reduce((m, p) => (m[p.verdict] = (m[p.verdict] ?? 0) + 1, m), {}))}`);
// breakdown of errors for the mutation tier
const fpMut = pairs.filter((p) => sameFile(p) && p.pred['coverage+mutation (confirmed)'] && !p.truth);
const fnMut = pairs.filter((p) => !p.pred['coverage+mutation (confirmed)'] && p.truth);
const missing = [...gtRed.keys()].filter((k) => !pairs.some((p) => `${p.A}\u0000${p.B}` === k));
if (o.json) writeFileSync(o.json, JSON.stringify({ rows, rowsAll, pairs, missing: missing.map((k) => k.split('\u0000')), sigMsPerTest: sigUs / Math.max(1, sigN) / 1000, staticMs }, null, 1));
console.log(`\nmutation FP (${fpMut.length}):`); for (const p of fpMut) console.log(`  ${p.A}  ⊑  ${p.B.split(' > ').slice(-1)}  [${p.verdict}${p.reason ? ': ' + p.reason : ''}]`);
console.log(`mutation FN among candidates (${fnMut.length}):`); for (const p of fnMut) console.log(`  ${p.A}  ⊑  ${p.B.split(' > ').slice(-1)}  ${p.onlyA?.slice(0, 2).join('; ')}`);
console.log(`GT redundant pairs never proposed by coverage (${missing.length}):`); for (const k of missing) console.log('  ' + k.split('\u0000').join('  ⊑  '));
if (o['write-survivors']) {
  const tier = o['survivors-tier'] || 'coverage+assert';
  writeFileSync(o['write-survivors'], JSON.stringify(pairs.filter((p) => p.pred[tier]).map((p) => [p.a, p.b])));
  console.log(`survivors of ${tier}: ${pairs.filter((p) => p.pred[tier]).length} → ${o['write-survivors']}`);
}
