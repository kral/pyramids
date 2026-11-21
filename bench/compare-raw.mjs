#!/usr/bin/env node
// Compares per-test hits (and block tables) of two v2 raw dirs, e.g. a forks run vs a vmThreads run.
//   node vto/bench/compare-raw.mjs <rawA> <rawB>
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

function load(dir) {
  const tests = new Map(), files = new Map(), loads = new Map();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line) continue;
      const r = JSON.parse(line);
      if (r.t === 'test') {
        const hits = Object.keys(r.hits).sort().map((k) => `${k}:${r.hits[k].join(',')}`).join(' ');
        const k = `${r.file}\u0000${r.line}\u0000${r.name}`;
        tests.set(k, (tests.has(k) ? tests.get(k) + '||' : '') + hits); // duplicate ids (it.each rows with equal labels)
      } else if (r.t === 'file') files.set(r.file, JSON.stringify(r.blocks));
      else if (r.t === 'fileload') loads.set(r.testFile, Object.keys(r.hits).sort().map((k) => `${k}:${r.hits[k].join(',')}`).join(' '));
    }
  }
  return { tests, files, loads };
}
const [a, b] = process.argv.slice(2).map((d) => load(path.resolve(d)));
const diff = (x, y) => { let same = 0, differ = [], onlyX = 0; for (const [k, v] of x) { if (!y.has(k)) onlyX++; else if (y.get(k) === v) same++; else differ.push(k); } return { same, differ, onlyX }; };
const t = diff(a.tests, b.tests), f = diff(a.files, b.files), l = diff(a.loads, b.loads);
console.log(`tests: ${a.tests.size} vs ${b.tests.size}; identical hits ${t.same}, different ${t.differ.length}, only in A ${t.onlyX}, only in B ${diff(b.tests, a.tests).onlyX}`);
console.log(`file block tables: ${a.files.size} vs ${b.files.size}; identical ${f.same}, different ${f.differ.length}`);
console.log(`fileload hits: ${a.loads.size} vs ${b.loads.size}; identical ${l.same}, different ${l.differ.length}`);
for (const k of t.differ.slice(0, 5)) console.log('  differs:', k.replace(/\u0000/g, ' | '), '\n    A:', a.tests.get(k).slice(0, 200), '\n    B:', b.tests.get(k).slice(0, 200));
process.exit(t.differ.length || f.differ.length ? 1 : 0);
