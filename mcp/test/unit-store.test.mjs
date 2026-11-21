import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MapStore, makeRemap, fileLevelChange } from '../src/store.mjs';
import { diffLines } from '../src/diff.mjs';
import { sha1, normText } from '../src/platform.mjs';

const blocksV1 = [[1, 0, 3, 1, 'f'], [2, 2, 2, 20, 'b'], [5, 0, 7, 1, 'f'], [6, 2, 6, 10, 'b']];
// v2: two lines inserted inside the first function (after line 2)
const blocksV2 = [[1, 0, 5, 1, 'f'], [2, 2, 2, 20, 'b'], [3, 2, 3, 9, 'b'], [7, 0, 9, 1, 'f'], [8, 2, 8, 10, 'b']];
const v1 = 'function a() {\n  if (x) y();\n}\n\nfunction b() {\n  z();\n}\n';
const v2 = 'function a() {\n  if (x) y();\n  if (q) r();\n  w();\n}\n\nfunction b() {\n  z();\n}\n';

test('makeRemap: untouched blocks move, blocks overlapping the change fail', () => {
  const remap = makeRemap(blocksV1, blocksV2, diffLines(v1, v2));
  assert.deepEqual(remap([2, 3]), { ids: [3, 4], ok: true });
  assert.equal(remap([0]).ok, false); // function a spans the insertion
  assert.deepEqual(remap([1]), { ids: [1], ok: true });
});

test('fileLevelChange: change outside blocks or in import-time block', () => {
  const h = diffLines('const A = 1;\n' + v1, 'const A = 2;\n' + v1);
  const shifted = blocksV1.map((b) => [b[0] + 1, b[1], b[2] + 1, b[3], b[4]]);
  assert.equal(fileLevelChange(shifted, h), true);
  const h2 = diffLines(v1, v1.replace('z();', 'zz();'));
  assert.equal(fileLevelChange(blocksV1, h2), false);
  assert.equal(fileLevelChange(blocksV1, h2, [2]), true); // function b ran at import time
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-store-')).replace(/\\/g, '/');
  fs.mkdirSync(`${root}/src`); fs.mkdirSync(`${root}/test`);
  fs.writeFileSync(`${root}/src/a.ts`, v1);
  fs.writeFileSync(`${root}/test/a.test.ts`, 'tests');
  return root;
}
const raw = (root, recs) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-raw-')); fs.writeFileSync(path.join(d, 'w-1.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n'); return d; };
const rd = (f) => { const text = fs.readFileSync(f, 'utf8'); return { sha: sha1(normText(text)), text }; };

test('ingest: full run records, partial run patches, version advance remaps non-rerun tests', () => {
  const root = setup();
  const st = new MapStore(root);
  const src = `${root}/src/a.ts`, tf = `${root}/test/a.test.ts`;
  const r1 = raw(root, [
    { t: 'file', file: 'src/a.ts', blocks: blocksV1 },
    { t: 'fileload', testFile: 'test/a.test.ts', hits: {}, modules: ['src/a.ts'] },
    { t: 'test', file: 'test/a.test.ts', name: 'a', line: 1, state: 'pass', hits: { 'src/a.ts': [0, 1] } },
    { t: 'test', file: 'test/a.test.ts', name: 'b', line: 2, state: 'pass', hits: { 'src/a.ts': [2, 3] } },
  ]);
  st.ingest(r1, { ran: new Map([[tf, { full: true }]]), snapshot: new Map(), loadFailed: new Set(), readFile: rd });
  assert.equal(st.testCount(), 2);
  assert.ok(st.state.files[src] && st.state.files[tf]);
  st.save();
  // edit: v2; only test "a" re-runs (partial)
  fs.writeFileSync(src, v2);
  const r2 = raw(root, [
    { t: 'file', file: 'src/a.ts', blocks: blocksV2 },
    { t: 'fileload', testFile: 'test/a.test.ts', hits: {}, modules: ['src/a.ts'] },
    { t: 'test', file: 'test/a.test.ts', name: 'a', line: 1, state: 'pass', hits: { 'src/a.ts': [0, 1, 2] } },
  ]);
  const stats = st.ingest(r2, { ran: new Map([[tf, { full: false }]]), snapshot: new Map([[src, rd(src)]]), loadFailed: new Set(), readFile: rd });
  assert.equal(stats.remapped, 1);
  const b = st.tests.get(tf).tests.get('test/a.test.ts:2 > b');
  assert.deepEqual(b.hits[src], [3, 4]);
  assert.equal(st.state.files[src].sha, rd(src).sha);
  assert.equal(Object.keys(st.state.dirtyTests).length, 0);
  // reload from disk gives the same map
  st.save();
  const st2 = new MapStore(root); st2.load();
  assert.equal(st2.testCount(), 2);
  assert.deepEqual(st2.tests.get(tf).tests.get('test/a.test.ts:2 > b').hits[src], [3, 4]);
});

test('ingest: load failure keeps old records and version; unstable file marks dirty', () => {
  const root = setup();
  const st = new MapStore(root);
  const src = `${root}/src/a.ts`, tf = `${root}/test/a.test.ts`;
  st.ingest(raw(root, [
    { t: 'file', file: 'src/a.ts', blocks: blocksV1 }, { t: 'fileload', testFile: 'test/a.test.ts', hits: {}, modules: ['src/a.ts'] },
    { t: 'test', file: 'test/a.test.ts', name: 'a', line: 1, state: 'pass', hits: { 'src/a.ts': [0] } },
  ]), { ran: new Map([[tf, { full: true }]]), snapshot: new Map(), loadFailed: new Set(), readFile: rd });
  const before = st.state.files[tf].sha;
  fs.writeFileSync(tf, 'broken');
  st.ingest(raw(root, []), { ran: new Map([[tf, { full: true }]]), snapshot: new Map(), loadFailed: new Set([tf]), readFile: rd });
  assert.equal(st.testCount(), 1);
  assert.equal(st.state.files[tf].sha, before);
});

test('engine lock: a second engine on the same .vto/ is refused while the first lives', async () => {
  const { Engine } = await import('../src/engine.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-lock-eng-'));
  const a = await new Engine(root, { config: { requireVitest: false } }).init();
  await assert.rejects(new Engine(root, { config: { requireVitest: false } }).init().then((e) => { e.ownsLock = false; return e; }), /in use by another vto engine|pid/);
  await a.close();
  const c = await new Engine(root, { config: { requireVitest: false } }).init();
  await c.close();
  await assert.rejects(new Engine(fs.mkdtempSync(path.join(os.tmpdir(), 'vto-novitest-'))).init(), /not a Vitest project/);
});
