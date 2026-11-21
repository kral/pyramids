import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { slash, pathKey, killTree, isCaseInsensitiveFs, analyzerCandidates } from '../src/platform.mjs';
import { runtimeBase, ensurePrivateDir, createServer, connectTo, readEndpoint, safeEqual, newAddress, acquireStartLock } from '../src/ipc.mjs';
import { computeCoverage } from '../src/coverage.mjs';

test('slash / pathKey normalise Windows paths', () => {
  assert.equal(slash('c:\\Users\\X\\proj\\'), 'C:/Users/X/proj');
  assert.equal(pathKey('C:\\A\\b.ts', true), 'c:/a/b.ts');
  assert.equal(pathKey('/A/b.ts', false), '/A/b.ts');
});

test('runtimeBase per platform (mocked)', () => {
  assert.match(runtimeBase({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, home: 'C:\\Users\\u' }), /AppData.Local.vto.run$/);
  assert.equal(runtimeBase({ platform: 'darwin', env: {}, home: '/Users/u' }), '/Users/u/Library/Caches/vto/run');
  assert.equal(runtimeBase({ platform: 'linux', env: {}, home: '/home/u' }), '/home/u/.cache/vto/run');
});

test('killTree uses taskkill /T /F on Windows and the process group on POSIX', () => {
  const calls = [];
  killTree(1234, { platform: 'win32', spawnSyncImpl: (c, a) => { calls.push([c, ...a]); return { status: 0 }; } });
  // N1c: absolute %SystemRoot%\System32 path, never a bare name (Windows looks in the current directory first)
  assert.match(calls[0][0], /^[A-Za-z]:\\.*\\System32\\taskkill\.exe$/);
  assert.deepEqual(calls[0].slice(1), ['/pid', '1234', '/T', '/F']);
  const sig = [];
  killTree(55, { platform: 'linux', kill: (p, s) => sig.push([p, s]) });
  assert.deepEqual(sig[0], [-55, 'SIGTERM']);
});

test('analyzer resolution never uses PATH or cwd', () => {
  const c = analyzerCandidates({ platform: 'win32', arch: 'x64', here: '/x/mcp/src' });
  assert.ok(c.some((x) => x.pkg === '@vto/analyzer-win32-x64' && x.file === 'bin/vto.exe'));
  assert.ok(c.every((x) => typeof x === 'object' && (x.pkg || path.isAbsolute(x.dev || x.env))));
  // installed inside node_modules: no sibling cargo build is ever considered (it would be repo-controlled)
  assert.ok(!analyzerCandidates({ here: '/proj/node_modules/vto-mcp/src', env: {} }).some((x) => x.dev));
});

test('case sensitivity is detected, not assumed', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-Case-'));
  assert.equal(typeof isCaseInsensitiveFs(d), 'boolean');
  if (process.platform === 'linux') assert.equal(isCaseInsensitiveFs(d), false);
});

test('ensurePrivateDir fixes group/other permissions (POSIX)', { skip: process.platform === 'win32' }, () => {
  const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vto-priv-')), 'x');
  fs.mkdirSync(d, { mode: 0o777 }); fs.chmodSync(d, 0o777);
  ensurePrivateDir(d);
  assert.equal(fs.statSync(d).mode & 0o777, 0o700);
});

test('IPC: token required, oversized message closes, socket private', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-ipc-'));
  process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-cache-'));
  const srv = await createServer({ root, onRequest: async (c, m, p) => ({ echo: m, p }) });
  try {
    const ep = readEndpoint(root);
    assert.ok(ep && ep.token.length === 64);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(ep.address).mode & 0o077, 0);
      assert.equal(fs.statSync(path.dirname(ep.address)).mode & 0o077, 0);
    }
    const c = await connectTo(ep);
    assert.deepEqual(await c.call('status', { a: 1 }), { echo: 'status', p: { a: 1 } });
    c.close();
    await assert.rejects(connectTo({ ...ep, token: 'x'.repeat(64) }), /authentication/);
    // raw socket without hello
    const s = net.connect(ep.address);
    const got = await new Promise((r) => { let b = ''; s.on('data', (d) => (b += d)); s.on('close', () => r(b)); s.write(JSON.stringify({ id: 1, method: 'status' }) + '\n'); });
    assert.match(got, /E_AUTH/);
    const s2 = net.connect(ep.address);
    const closed = await new Promise((r) => { s2.on('close', () => r(true)); s2.on('error', () => {}); s2.on('data', () => {}); s2.write('x'.repeat((1 << 20) + 10)); });
    assert.equal(closed, true);
  } finally { srv.close(); }
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
});

test('socket path fallback stays under the sun_path limit', () => {
  process.env.XDG_CACHE_HOME = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vto-long-')), 'x'.repeat(120));
  const { address } = newAddress('/some/project');
  assert.ok(Buffer.byteLength(address) <= 100, address);
});

test('start lock is exclusive', () => {
  process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-lock-'));
  const r1 = acquireStartLock('/p'); const r2 = acquireStartLock('/p');
  assert.ok(r1); assert.equal(r2, null); r1(); const r3 = acquireStartLock('/p'); assert.ok(r3); r3();
});

test('computeCoverage: covered / partial / uncovered and branches', () => {
  const blocks = [[1, 0, 4, 1, 'f'], [2, 4, 2, 10, 'b'], [2, 12, 2, 20, 'b'], [3, 2, 3, 9, 'b'], [6, 0, 7, 1, 'f']];
  const c = computeCoverage(blocks, [['t1', [0, 1]], ['t2', [0, 1]]], { cap: 1 });
  assert.deepEqual(c.lines.covered, [1, 4]);
  assert.deepEqual(c.lines.partial, [2]);
  assert.deepEqual(c.lines.uncovered, [3, 6, 7]);
  assert.deepEqual(c.branches[2], [1, 0]);
  assert.deepEqual(c.testsByLine[1], ['t1']);
  assert.equal(c.more[1], 1);
});
