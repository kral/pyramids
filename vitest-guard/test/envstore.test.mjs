import { pathToFileURL } from 'node:url';
// env.json has ONE owner (src/envstore.mjs): precedence miss > probe > static, lock, atomic write
// (REVIEW-2-architecture N4 / A-6, REVIEW-2-security N9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateEnv, readEnv, mergeEnvEntry, normalizeEnvEntry, envRank, envKey, envFilePath, foldEnvRecords, removeEnvEntries, withEnvLock, ENV_FORMAT } from '../src/envstore.mjs';

const store = fileURLToPath(new URL('../src/envstore.mjs', import.meta.url));
const mk = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vmg-env-')));
const N = (r) => normalizeEnvEntry(r, { producer: 't', at: 'T' });

test('envstore: precedence miss > probe > static (pure rule)', () => {
  const miss = N({ source: 'probe', dom: true, miss: { key: 'document' } });
  const probeDom = N({ source: 'probe', dom: true, env: 'jsdom' });
  const probeNode = N({ source: 'probe', dom: false, env: 'jsdom' });
  const stat = N({ source: 'static', group: 'node' });
  assert.deepEqual([miss, probeDom, stat, null].map(envRank), [3, 2, 1, 0]);
  assert.equal(miss.group, 'dom'); assert.equal(probeNode.group, 'node'); assert.equal(probeDom.group, 'dom');
  assert.equal(mergeEnvEntry(undefined, stat), stat, 'first entry is stored');
  assert.equal(mergeEnvEntry(probeNode, stat), probeNode, 'static never replaces a probe');
  assert.equal(mergeEnvEntry(miss, stat), miss, 'static never replaces a miss');
  assert.equal(mergeEnvEntry(miss, probeNode), miss, 'a later probe never replaces a miss');
  assert.equal(mergeEnvEntry(miss, probeDom), miss);
  assert.equal(mergeEnvEntry(stat, probeNode), probeNode, 'a probe replaces a static guess');
  assert.equal(mergeEnvEntry(probeNode, probeDom), probeDom, 'node -> dom on new evidence');
  assert.equal(mergeEnvEntry(probeDom, probeNode), probeDom, 'dom:true is sticky among probes');
  assert.equal(mergeEnvEntry(probeDom, N({ source: 'probe', env: 'jsdom', group: 'dom' })), probeDom, 'a probe without a dom measurement (daemon) does not erase dom:true');
  assert.equal(mergeEnvEntry(probeDom, miss), miss);
  const stat2 = N({ source: 'static', group: 'dom' });
  assert.equal(mergeEnvEntry(stat, stat2), stat2, 'static replaces static');
  assert.equal(mergeEnvEntry(probeDom, null), probeDom); assert.equal(N({ source: 'guess', group: 'dom' }), null); assert.equal(N({ source: 'static' }), null, 'no group derivable');
});

test('envstore: the daemon cannot erase vitest-guard evidence (A-6 / N4 repro), other entries and extension fields survive', () => {
  const root = mk();
  // vitest-guard: a DOM miss and a measured DOM user
  updateEnv(root, { 'test/miss.test.ts': { source: 'probe', dom: true, env: 'node', miss: { key: 'document' } }, 'test/dom.test.ts': { source: 'probe', dom: true, env: 'jsdom', via: 'document mutation' }, 'test/guess.test.ts': { source: 'static', group: 'node' } }, { producer: 'vitest-guard' });
  // daemon (old classify.writeEnvJson behaviour): its own probe result for every file, static guesses for the rest
  const r = updateEnv(root, new Map([
    [path.join(root, 'test/miss.test.ts'), { group: 'node', source: 'probe', env: 'node', dom: false }],
    ['test/dom.test.ts', { group: 'node', source: 'static' }],
    ['test/guess.test.ts', { group: 'dom', source: 'probe', env: 'jsdom', dom: true }],
    ['test/new.test.ts', { group: 'node', source: 'static' }],
  ]), { producer: 'vto-daemon' });
  assert.deepEqual(r.changed.sort(), ['test/guess.test.ts', 'test/new.test.ts']);
  const doc = JSON.parse(fs.readFileSync(envFilePath(root), 'utf8'));
  assert.equal(doc.format, ENV_FORMAT); assert.equal(doc.producer, 'vto-daemon');
  const f = doc.files;
  assert.deepEqual(f['test/miss.test.ts'].miss, { key: 'document' }); assert.equal(f['test/miss.test.ts'].group, 'dom'); assert.equal(f['test/miss.test.ts'].by, 'vitest-guard');
  assert.equal(f['test/dom.test.ts'].source, 'probe'); assert.equal(f['test/dom.test.ts'].via, 'document mutation');
  assert.equal(f['test/guess.test.ts'].source, 'probe'); assert.equal(f['test/guess.test.ts'].by, 'vto-daemon');
  assert.equal(f['test/new.test.ts'].source, 'static');
  assert.ok(fs.existsSync(path.join(root, '.vitest-guard/run/.gitignore')), 'run/ is git-ignored whoever creates it');
  assert.ok(!fs.readdirSync(path.join(root, '.vitest-guard/run')).some((n) => /\.tmp$|\.lock$/.test(n)), 'no temp or lock file left');
  // forgetting is explicit
  assert.deepEqual(removeEnvEntries(root, ['test/miss.test.ts']).changed, ['test/miss.test.ts']);
  assert.equal(readEnv(root).files['test/miss.test.ts'], undefined);
});

test('envstore: keys are validated (N9), invalid records are rejected, a hostile env.json is not trusted', () => {
  const root = mk();
  assert.equal(envKey(root, '../x.test.ts'), null); assert.equal(envKey(root, '/etc/passwd'), null); assert.equal(envKey(root, 'a\nb'), null);
  assert.equal(envKey(root, path.join(root, 'a', 'b.test.ts')), 'a/b.test.ts'); assert.equal(envKey(root, './a/b.test.ts'), 'a/b.test.ts');
  const r = updateEnv(root, { '../../evil.test.ts': { source: 'probe', dom: true }, 'ok.test.ts': { source: 'nonsense' }, 'fine.test.ts': { source: 'probe', dom: false } });
  assert.deepEqual(r.rejected.sort(), ['../../evil.test.ts', 'ok.test.ts']); assert.deepEqual(Object.keys(r.files), ['fine.test.ts']);
  fs.writeFileSync(envFilePath(root), JSON.stringify({ format: ENV_FORMAT, files: { '../up.test.ts': { group: 'dom', source: 'probe', dom: true }, 'a.test.ts': { group: 'weird', source: 'probe' }, 'b.test.ts': { group: 'node', source: 'static' }, 'c.test.ts': 7 } }));
  assert.deepEqual(Object.keys(readEnv(root).files), ['b.test.ts']);
  fs.writeFileSync(envFilePath(root), '{ not json');
  assert.deepEqual(readEnv(root).files, {});
  assert.equal(updateEnv(root, { 'z.test.ts': { source: 'static', group: 'node' } }).written, true, 'a corrupt file is replaced, not fatal');
  // legacy vitest-guard layout is converted, a miss stays a miss
  fs.writeFileSync(envFilePath(root), JSON.stringify({ 'm.test.ts': { dom: true, source: 'miss', key: 'window' }, 'n.test.ts': { dom: false, source: 'probe' } }));
  const legacy = readEnv(root).files;
  assert.equal(envRank(legacy['m.test.ts']), 3); assert.equal(legacy['n.test.ts'].group, 'node');
});

test('envstore: never writes through a symlinked state dir; replaces a symlinked env.json instead of following it', { skip: process.platform === 'win32' ? 'symlinks need privileges on Windows' : false }, () => {
  const root = mk(), outside = mk();
  fs.mkdirSync(path.join(root, '.vitest-guard'));
  fs.symlinkSync(outside, path.join(root, '.vitest-guard', 'run'));
  const r = updateEnv(root, { 'a.test.ts': { source: 'probe', dom: true } });
  assert.equal(r.written, false); assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(r.files['a.test.ts'].group, 'dom', 'the merged view is still returned');
  const root2 = mk(), target = path.join(mk(), 'victim.txt');
  fs.writeFileSync(target, 'keep');
  fs.mkdirSync(path.join(root2, '.vitest-guard/run'), { recursive: true });
  fs.symlinkSync(target, envFilePath(root2));
  assert.equal(updateEnv(root2, { 'a.test.ts': { source: 'probe', dom: true } }).written, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep'); assert.ok(!fs.lstatSync(envFilePath(root2)).isSymbolicLink());
});

test('envstore: concurrent writers lose no update (lock + atomic replace)', async () => {
  const root = mk();
  const procs = 6, per = 25;
  const script = `import { updateEnv } from ${JSON.stringify(pathToFileURL(store).href)};
const [root, id, per] = process.argv.slice(2);
for (let i = 0; i < Number(per); i++) { const r = updateEnv(root, { ['p' + id + '/f' + i + '.test.ts']: { source: i % 2 ? 'probe' : 'static', group: 'node', dom: false } }, { producer: 'p' + id }); if (!r.written || !r.locked) { console.error('not written/locked', r.written, r.locked); process.exit(3); } }`;
  const f = path.join(root, 'writer.mjs');
  fs.writeFileSync(f, script);
  const codes = await Promise.all(Array.from({ length: procs }, (_, id) => new Promise((res) => { const c = spawn(process.execPath, [f, root, String(id), String(per)], { stdio: 'inherit' }); c.on('close', res); })));
  assert.deepEqual(codes, Array(procs).fill(0));
  const files = readEnv(root).files;
  assert.equal(Object.keys(files).length, procs * per, 'every entry of every writer is present');
  JSON.parse(fs.readFileSync(envFilePath(root), 'utf8'));
});

test('envstore: a stale lock (dead holder) is taken over; a held lock times out without blocking the write', () => {
  const root = mk();
  fs.mkdirSync(path.join(root, '.vitest-guard/run'), { recursive: true });
  const lock = path.join(root, '.vitest-guard/run/env.json.lock');
  fs.writeFileSync(lock, '999999999:0:dead');
  const old = new Date(Date.now() - 5000); fs.utimesSync(lock, old, old);
  assert.equal(updateEnv(root, { 'a.test.ts': { source: 'static', group: 'node' } }).locked, true);
  assert.ok(!fs.existsSync(lock));
  fs.writeFileSync(lock, `${process.pid}:${Date.now()}:live`); // held by a live process (us), fresh
  const t0 = Date.now();
  const r = updateEnv(root, { 'b.test.ts': { source: 'static', group: 'node' } }, { lock: { timeoutMs: 150 } });
  assert.equal(r.locked, false); assert.equal(r.written, true); assert.ok(Date.now() - t0 < 2000);
  assert.ok(fs.existsSync(lock), "someone else's live lock is not removed");
  assert.equal(withEnvLock(mk(), (held) => held).value, true);
});

test('envstore: foldEnvRecords folds per-worker records once and keeps what other producers wrote', () => {
  const root = mk();
  updateEnv(root, { 'other/x.test.ts': { group: 'node', source: 'probe', env: 'jsdom', dom: false } }, { producer: 'vto-daemon' });
  fs.writeFileSync(path.join(root, '.vitest-guard/run/env-1-1.jsonl'), [{ t: 'env-miss', file: 'm.test.ts', key: 'document' }, { t: 'env', file: 'm.test.ts', dom: false }, { t: 'env', file: 'd.test.ts', dom: true, env: 'jsdom', via: 'window' }, 'garbage'].map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n'));
  const files = foldEnvRecords(root);
  assert.equal(envRank(files['m.test.ts']), 3); assert.equal(files['d.test.ts'].via, 'window'); assert.equal(files['other/x.test.ts'].by, 'vto-daemon');
  assert.ok(!fs.existsSync(path.join(root, '.vitest-guard/run/env-1-1.jsonl')), 'folded record file removed');
  assert.deepEqual(foldEnvRecords(root), files, 'idempotent');
});
