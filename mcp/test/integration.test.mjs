// Integration tests: real Vitest 5.1.1 on test/fixture (copied to a temp dir).
// node_modules: test/fixture/node_modules (CI: `npm ci` there) or $VTO_TEST_NODE_MODULES.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.mjs';
import { dispatch } from '../src/api.mjs';
import { Backend } from '../src/client.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixture');
const nm = [path.join(fixture, 'node_modules'), process.env.VTO_TEST_NODE_MODULES, '/home/claude/demo/node_modules'].find((p) => p && fs.existsSync(path.join(p, 'vitest')));
const skip = nm ? false : 'no node_modules with vitest for the fixture (npm ci in test/fixture)';

function copyFixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-it-'));
  fs.cpSync(fixture, d, { recursive: true, filter: (s) => !s.includes('node_modules') });
  fs.symlinkSync(nm, path.join(d, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return d;
}
const edit = (root, f, a, b) => { const p = path.join(root, f); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(a, b)); };

before(() => { process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-it-cache-')); process.env.VTO_FIXTURE_SLOW_MS = '5000'; });

test('stateless engine: first run records the map, edits select only affected tests, map patched', { skip, timeout: 120000 }, async () => {
  const root = copyFixture();
  const eng = await new Engine(root).init();
  try {
    const a0 = await dispatch(eng, 'affected', {});
    assert.equal(a0.runAll, true);
    const s1 = await dispatch(eng, 'start_run', { kind: 'affected' });
    const r1 = await eng.waitRun(s1.runId);
    assert.equal(r1.failed, 0);
    assert.equal(r1.passed, 8);
    assert.equal(eng.store.testCount(), 8);
    assert.equal((await dispatch(eng, 'affected', {})).count, 0);
    // logic change in price.ts (vip branch): price tests that reach it, not format tests
    edit(root, 'src/price.ts', 'total *= 0.8', 'total *= 0.7');
    const a1 = await dispatch(eng, 'affected', {});
    assert.equal(a1.runAll, false);
    assert.ok(a1.files.includes('test/price.test.ts') && !a1.files.includes('test/format.test.ts'), JSON.stringify(a1));
    const r2 = await eng.waitRun((await dispatch(eng, 'start_run', {})).runId);
    assert.equal(r2.failed, 3); // price > vip, early + slow vip check
    assert.ok(r2.failures.every((f) => f.at && f.error.startsWith('AssertionError')));
    assert.ok(r2.mapUpdated.files >= 1);
    // failing tests stay selected until they pass
    assert.ok((await dispatch(eng, 'affected', {})).count >= 2);
    const why = await dispatch(eng, 'why_failed', { test: 'test/price.test.ts:6' });
    assert.match(why.error, /expected 63 to be 72/);
    assert.ok(why.frames.length >= 1);
    edit(root, 'src/price.ts', 'total *= 0.7', 'total *= 0.8');
    const r3 = await eng.waitRun((await dispatch(eng, 'start_run', {})).runId);
    assert.equal(r3.failed, 0);
    assert.equal((await dispatch(eng, 'affected', {})).count, 0);
    // top-level constant (outside every block) → every loader of format.ts
    edit(root, 'src/format.ts', "'Kč'", "'CZK'");
    const a2 = await dispatch(eng, 'affected', {});
    assert.deepEqual(a2.files, ['test/format.test.ts']);
    // config change → stale, run all
    fs.appendFileSync(path.join(root, 'vitest.config.mjs'), '\n// changed\n');
    const a3 = await dispatch(eng, 'affected', {});
    assert.equal(a3.runAll, true);
    assert.ok(a3.reasons.some((r) => r.includes('vitest.config.mjs')));
    // coverage queries
    const cov = await dispatch(eng, 'coverage', { file: 'src/price.ts' });
    assert.ok(cov.counts.covered > 0);
    const tf = await dispatch(eng, 'tests_for', { file: 'src/price.ts', line: 5 });
    assert.ok(tf.tests.some((t) => t.includes('vip')));
    // validation
    await assert.rejects(dispatch(eng, 'affected', { base: '--output=/tmp/pwned' }), /base must be/);
    await assert.rejects(dispatch(eng, 'start_run', { kind: 'tests', filters: ['test/price.test.ts'] }), /typed filters/);
    await assert.rejects(dispatch(eng, 'start_run', { kind: 'tests', filters: [{ file: '../../etc/passwd' }] }), /inside the project root/);
  } finally { await eng.close(); }
});

test('daemon: failures stream before run end, fix loop re-runs a fixed test during the run, console redacted', { skip, timeout: 180000 }, async () => {
  const root = copyFixture();
  const b = await Backend.open(root, { daemon: true, client: 'vto-test' });
  assert.equal(b.kind, 'daemon', b.daemonError);
  try {
    await b.call('wait_run', { runId: (await b.call('start_run', { kind: 'full' })).runId });
    edit(root, 'src/price.ts', 'total *= 0.8', 'total *= 0.7');
    await b.call('subscribe', { topics: ['run'] });
    const evs = [];
    let fixed = false;
    b.on('event', (ev) => {
      evs.push({ ...ev, t: Date.now() });
      // fix the bug as soon as the first failure arrives (the slow test keeps the run going)
      if (ev.ev === 'failure' && !fixed) { fixed = true; setTimeout(() => edit(root, 'src/price.ts', 'total *= 0.7', 'total *= 0.8'), 100); }
    });
    const s = await b.call('start_run', { kind: 'affected' });
    const nf = await b.call('next_failures', { runId: s.runId, waitS: 20 });
    assert.ok(nf.failures.length >= 1, JSON.stringify(nf));
    // explicit re-run while the main run is busy → fix lane, does not wait for the main run
    const rr = await b.call('rerun_failed', { ids: [nf.failures[0].id] });
    assert.equal(rr.lane, 'fix');
    const rrDone = await b.call('wait_run', { runId: rr.runId });
    const mainStill = await b.call('run_status', { runId: s.runId });
    assert.equal(rrDone.ran, 1);
    assert.equal(mainStill.status, 'running', 'fix-lane re-run must finish while the main run is still running');
    const r = await b.call('wait_run', { runId: s.runId });
    const rs = evs.find((e) => e.ev === 'run-start' && e.runId === s.runId);
    assert.ok(rs.projects && Object.values(rs.projects).reduce((n, p) => n + p.tests, 0) === rs.total, JSON.stringify(rs));
    const firstFail = evs.find((e) => e.ev === 'failure' && e.runId === s.runId);
    const end = evs.find((e) => e.ev === 'run-end' && e.runId === s.runId);
    assert.ok(firstFail && end && firstFail.t < end.t - 1000, 'failure must arrive well before run-end');
    assert.ok(r.firstFailureMs < r.ms);
    const fx = evs.filter((e) => e.ev === 'fix-rerun');
    assert.ok(fx.some((e) => e.state === 'pass'), `fix-rerun pass expected, got ${JSON.stringify(fx)}`);
    assert.ok(r.fixedDuringRun?.length >= 1);
    assert.ok(fs.existsSync(path.join(root, '.vto', 'runs', `${s.runId}.jsonl`)));
    // secret in console output of a failing test is redacted
    edit(root, 'test/format.test.ts', "toBe('2.00 Kč')", "toBe('nope')");
    const r2 = await b.call('wait_run', { runId: (await b.call('start_run', {})).runId });
    assert.equal(r2.failed, 1);
    const why = await b.call('why_failed', { test: 'test/format.test.ts:4' });
    assert.ok(why.console && !why.console.includes('supersecret123') && why.console.includes('[REDACTED]'), why.console);
    const st = await b.call('status');
    assert.equal(st.mode, 'daemon');
    assert.equal(st.warm, true);
  } finally { await b.call('stop').catch(() => {}); await b.close(); }
});

// token budget per tool (MCP.md: summaries ≤ ~300 tokens; hard cap per response 8000 chars)
const BUDGET = { affected_tests: 300, run_affected: 450, run_tests: 450, why_failed: 600, daemon_status: 300, start_run: 150, next_failures: 450, run_status: 450,
  test_overlap: 600, next_task: 450, list_tasks: 300, complete_task: 150, enqueue_task: 450, slow_tests: 450, slow_imports: 450, suggest_env: 300, coverage_of: 400, tests_for_line: 400, vm_guard_status: 250, savings_report: 600 };

test('MCP over stdio: every tool answers within its token budget', { skip, timeout: 180000 }, async () => {
  const root = copyFixture();
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(here, '../bin/vto-mcp.mjs'), '--root', root, '--no-daemon'], stderr: 'pipe', env: { ...process.env } });
  const client = new Client({ name: 'vto-test', version: '0' });
  await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ['affected_tests', 'run_affected', 'run_tests', 'why_failed', 'daemon_status', 'start_run', 'next_failures', 'run_status', 'cancel_run', 'rerun_failed', 'test_overlap', 'slow_tests', 'slow_imports', 'suggest_env', 'coverage_of', 'tests_for_line', 'vm_guard_status', 'savings_report'])
      assert.ok(names.includes(t), t);
    assert.ok(!names.includes('verify'));
    const call = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 170000 });
      const text = r.content.map((c) => c.text).join('');
      const tok = Math.ceil(text.length / 4);
      assert.ok(!r.isError, `${name}: ${text}`);
      assert.ok(text.startsWith('[vto/1'), 'untrusted-data prefix');
      assert.ok(tok <= BUDGET[name], `${name}: ${tok} tokens > ${BUDGET[name]}: ${text}`);
      return JSON.parse(text.slice(text.indexOf('\n') + 1));
    };
    await call('run_affected');
    edit(root, 'src/price.ts', 'total *= 0.8', 'total *= 0.7');
    await call('affected_tests');
    const r = await call('run_affected');
    assert.equal(r.failed, 3);
    await call('why_failed', { test: r.failures[0].id });
    await call('run_tests', { filters: [{ file: 'test/price.test.ts', line: 6 }] });
    const s = await call('start_run', { kind: 'failed' });
    await call('next_failures', { runId: s.runId, waitS: 10 });
    await call('run_status', { runId: s.runId });
    await call('daemon_status');
    await call('coverage_of', { file: 'src/price.ts' });
    await call('coverage_of', { file: 'src/price.ts', line: 5 });
    await call('tests_for_line', { file: 'src/price.ts', line: 5 });
    await call('test_overlap', {});
    await call('slow_tests', {});
    await call('slow_imports', {});
    await call('suggest_env', {});
    await call('vm_guard_status');
    const q = await call('enqueue_task', { runId: r.runId, group: r.failures[0].group });
    assert.ok(q.task.taskId);
    await call('list_tasks');
    const claimed = await call('next_task', { agent: 'test' });
    assert.equal(claimed.task.status, 'claimed');
    await call('complete_task', { taskId: claimed.task.taskId });
    await call('savings_report');
    // strict schemas: unknown fields and raw argv are rejected
    const bad = await client.callTool({ name: 'run_tests', arguments: { filters: [{ file: 'test/price.test.ts', reporter: './evil.mjs' }] } });
    assert.ok(bad.isError);
    const bad2 = await client.callTool({ name: 'affected_tests', arguments: { base: '--output=x' } });
    assert.ok(bad2.isError);
  } finally { await client.close(); }
});
