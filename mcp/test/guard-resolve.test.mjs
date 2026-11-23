import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveGuard, GUARD_PROTOCOL, protocolOf, CHECKOUT_GUARD_DIR } from '../src/guard-resolve.mjs';
import { Metrics } from '../src/metrics.mjs';

function projectWith(pkg) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-gr-'));
  fs.writeFileSync(path.join(d, 'package.json'), '{"name":"p"}');
  const g = path.join(d, 'node_modules', '@jirikral', 'vitest-guard');
  fs.mkdirSync(path.join(g, 'src'), { recursive: true });
  fs.writeFileSync(path.join(g, 'package.json'), JSON.stringify({ name: '@jirikral/vitest-guard', version: '9.9.9', ...pkg }));
  fs.writeFileSync(path.join(g, 'src', 'index.mjs'), '');
  return { d, g };
}

test('S6: the checkout copy declares the protocol vto expects', () => {
  assert.equal(protocolOf(CHECKOUT_GUARD_DIR), GUARD_PROTOCOL);
});

test('S6: the project\'s installed copy is preferred over the checkout', () => {
  const { d, g } = projectWith({ vitestGuardProtocol: GUARD_PROTOCOL });
  try {
    const r = resolveGuard(d);
    assert.equal(r.source, 'project');
    assert.equal(fs.realpathSync(r.dir), fs.realpathSync(g));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('S6: a protocol mismatch is a clear error, an older copy without protocol too', () => {
  for (const pkg of [{ vitestGuardProtocol: GUARD_PROTOCOL + 1 }, {}]) {
    const { d } = projectWith(pkg);
    try { assert.throws(() => resolveGuard(d), /protocol mismatch: this vto expects protocol 1.*9\.9\.9/); } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }
});

test('S6: without an installed copy the checkout is used', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-gr-'));
  try { assert.equal(resolveGuard(d).source, 'checkout'); } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('S8: run records carry the origin and the savings report counts it', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-met-'));
  try {
    const m = new Metrics(path.join(d, '.vto'));
    const eng = { mode: 'stateless', poolName: () => 'forks', store: { testCount: () => 2, state: { testFiles: ['a'] }, tests: new Map() } };
    const run = (runId, origin) => ({ runId, kind: 'full', origin, startedAt: 1, counts: { pass: 2, fail: 0, skip: 0 }, files: 1, status: 'done', ms: 10 });
    m.recordRun(eng, run('r1', 'agent')); m.recordRun(eng, run('r2', 'cli'));
    assert.deepEqual(m.read().map((r) => r.origin), ['agent', 'cli']);
    assert.deepEqual(m.report().byOrigin, { agent: 1, cli: 1 });
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
