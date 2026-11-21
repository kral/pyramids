#!/usr/bin/env node
// Compares v2 raw data (hits) against the probe ground truth of a generated fixture.
//   node vto/bench/compare-expected.mjs <rawDir> <projectDir>
// Checks: every planted relation, the identical-coverage partition, and strict containment counts.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const [rawDir, proj] = process.argv.slice(2).map((p) => path.resolve(p));
const exp = JSON.parse(readFileSync(path.join(proj, 'EXPECTED.json'), 'utf8'));
const tests = new Map();
for (const f of readdirSync(rawDir)) {
  if (!f.endsWith('.jsonl')) continue;
  for (const line of readFileSync(path.join(rawDir, f), 'utf8').split('\n')) {
    if (!line.includes('"t":"test"')) continue;
    const r = JSON.parse(line);
    const atoms = [];
    for (const [file, ids] of Object.entries(r.hits)) for (const i of ids) atoms.push(`${path.relative(proj, file)}#${i}`);
    tests.set(`${path.relative(proj, r.file)}\u0000${r.name}`, { ...r, atoms: atoms.sort() });
  }
}
const get = (t) => tests.get(`${t.file}\u0000${t.name}`);
let ok = 0, miss = 0; const bad = [];
for (const p of exp.planted.items) {
  const a = get(p.a), b = get(p.b);
  if (!a || !b) { miss++; continue; }
  const sa = new Set(a.atoms), sb = new Set(b.atoms);
  const aInB = a.atoms.every((x) => sb.has(x)), bInA = b.atoms.every((x) => sa.has(x));
  const actual = aInB && bInA ? 'identical' : aInB ? 'subsumed' : bInA ? 'contains' : 'overlap';
  if (actual === p.kind) ok++; else bad.push({ ...p, v2: actual });
}
// partition comparison
const groupOf = new Map();
exp.identicalGroups.forEach((g, i) => g.forEach((t) => groupOf.set(`${t.file}\u0000${t.name}`, i)));
const bySig = new Map();
for (const [k, t] of tests) { if (!t.atoms.length) continue; const s = t.atoms.join('|'); if (!bySig.has(s)) bySig.set(s, []); bySig.get(s).push(k); }
const v2Groups = [...bySig.values()].filter((g) => g.length > 1);
let same = 0, split = 0, merged = 0;
for (const g of v2Groups) {
  const ids = new Set(g.map((k) => groupOf.get(k)));
  if (ids.size === 1 && !ids.has(undefined)) { const eg = exp.identicalGroups[[...ids][0]]; if (eg.length === g.length) same++; else split++; }
  else merged++;
}
console.log(`tests in raw: ${tests.size} (expected ${exp.tests})`);
console.log(`planted relations: ${ok}/${exp.planted.items.length} match v2${miss ? `, ${miss} not found` : ''}`);
console.log(`identical groups: ground truth ${exp.identicalGroups.length}, v2 ${v2Groups.length}; exactly equal ${same}, v2 group ⊂ GT group ${split}, v2 group mixes GT groups ${merged}`);
if (bad.length) console.log('mismatches (first 5):', JSON.stringify(bad.slice(0, 5), null, 1));
