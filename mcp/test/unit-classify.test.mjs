import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, staticGroup, splitWorkers, writeEnvJson } from '../src/classify.mjs';

test('static fallback and probe-based classification', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-cls-'));
  const w = (n, s) => { const p = path.join(d, n); fs.writeFileSync(p, s); return p; };
  const a = w('a.test.tsx', ''), b = w('b.test.ts', "import { render } from '@testing-library/react'"), c = w('c.test.ts', 'expect(1).toBe(1)');
  assert.equal(staticGroup(a), 'dom'); assert.equal(staticGroup(b), 'dom'); assert.equal(staticGroup(c), 'node');
  const eng = { store: { tests: new Map([[a, { env: { env: 'node', dom: false } }], [b, { env: { env: 'jsdom', dom: true } }]]) } };
  const cls = classify(eng, [a, b, c]);
  assert.deepEqual([cls.get(a).group, cls.get(a).source], ['node', 'probe']);
  assert.deepEqual([cls.get(b).group, cls.get(b).source], ['dom', 'probe']);
  assert.deepEqual([cls.get(c).group, cls.get(c).source], ['node', 'static']);
  writeEnvJson(d, cls, (x) => path.basename(x));
  const f = path.join(d, '.vitest-guard', 'run', 'env.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(j.format, 'vto-env/1');
  assert.equal(j.files['a.test.tsx'].group, 'node');
  // a static result never overwrites a measurement
  writeEnvJson(d, new Map([[a, { group: 'dom', source: 'static' }]]), (x) => path.basename(x));
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).files['a.test.tsx'].source, 'probe');
});

test('worker budget split by measured time, at least one each', () => {
  assert.deepEqual(splitWorkers(1, { dom: 10, node: 1 }), { dom: 1, node: 1 });
  assert.deepEqual(splitWorkers(4, { dom: 300, node: 100 }), { dom: 3, node: 1 });
  assert.deepEqual(splitWorkers(3, { dom: 1, node: 1000 }), { dom: 1, node: 2 });
});

test('vitest_guard_status reads run logs from .vitest-guard/run/logs/ and the older .vitest-guard/run/', async () => {
  const { vitestGuardStatus } = await import('../src/analysis.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-vmg-'));
  fs.mkdirSync(path.join(root, '.vitest-guard', 'run', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.vitest-guard', 'incompatible.json'), JSON.stringify({ vm: { 'test/a.test.ts': {} } }));
  fs.writeFileSync(path.join(root, '.vitest-guard', 'run', 'logs', 'w-1-0.jsonl'), '{"t":"start","file":"a","seq":1,"dirty":[{"kind":"x"}]}\n{"t":"start","file":"b","seq":2}\n');
  fs.writeFileSync(path.join(root, '.vitest-guard', 'run', 'w-2-0.jsonl'), '{"t":"start","file":"c","seq":1}\n');
  fs.writeFileSync(path.join(root, '.vitest-guard', 'run', 'env.json'), '{"format":"vto-env/1","files":{}}');
  const eng = { root, store: { state: { lane: { vitestGuard: 'vm', pool: 'vmThreads' } } }, envelope: (o) => o };
  const r = vitestGuardStatus(eng);
  assert.equal(r.filesLogged, 3);
  assert.equal(r.dirtyStarts, 1);
  assert.equal(r.quarantined.vmCount, 1);
  assert.equal(r.enabled, true);
});
