import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, estimate } from '../savings-estimate.mjs';

test('savings estimate: model, billing rounded up per job, validation', () => {
  const e = estimate(parse(['--suite-min', '10', '--selected', '0.1', '--run-all', '0.5', '--overhead', '0', '--ci-runs', '1', '--days', '1', '--devs', '1', '--local-runs', '6']));
  // expected run = 0.5 × 10 + 0.5 × 1 = 5.5 min; saved 4.5 min per run
  assert.deepEqual(e.perRun, { before: 10, after: 5.5, savedMin: 4.5, share: 0.45 });
  assert.equal(e.month.ciRunnerMinutes, 5); // billed 10 → 0.5 × 10 + 0.5 × ceil(1) = 5.5 → saved 4.5, rounded
  assert.equal(e.month.devWaitHours, 0.5); // 6 runs × 4.5 min
  assert.equal(e.month.devUsd, null);
  assert.equal(e.month.tokens, 0);
  // an affected run is never more expensive than the full run, savings never negative
  const z = estimate(parse(['--suite-min', '1', '--selected', '1', '--overhead', '5']));
  assert.equal(z.perRun.savedMin, 0);
  assert.throws(() => parse([]), /--suite-min is required/);
  assert.throws(() => parse(['--suite-min', '3', '--selected', '20']), /share between 0 and 1/);
  assert.throws(() => parse(['--suite-min', '3', '--shards', '1.5']), /whole number/);
  assert.throws(() => parse(['--suite-min', '3', '--nope', '1']), /unknown option/);
});

test('savings estimate --from-measured: aggregates metrics, explicit flags win, fast-pool full runs converted', async () => {
  const { measuredFrom } = await import('../savings-estimate.mjs');
  const now = Date.parse('2026-11-22T12:00:00Z');
  const at = (d) => new Date(now - d * 864e5).toISOString();
  const recs = [
    { t: 'run', at: at(5), kind: 'full', status: 'done', pool: 'forks', testsRun: 100, suiteTotal: 100, wallMs: 200000 },
    { t: 'run', at: at(4), kind: 'full', status: 'done', pool: 'vitest-guard:vm', testsRun: 100, suiteTotal: 100, wallMs: 100000 },
    { t: 'run', at: at(1), kind: 'affected', status: 'done', pool: 'vitest-guard:vm', testsRun: 10, suiteTotal: 100, wallMs: 5000 },
    { t: 'run', at: at(1), kind: 'affected', status: 'done', pool: 'vitest-guard:vm', testsRun: 30, suiteTotal: 100, wallMs: 9000 },
    { t: 'run', at: at(2), kind: 'affected', status: 'done', pool: 'vitest-guard:vm', testsRun: 100, suiteTotal: 100, wallMs: 99000 }, // fell back to all
    { t: 'run', at: at(2), kind: 'affected', status: 'error', testsRun: 1, suiteTotal: 100 },                                       // not done: ignored
    { t: 'run', at: at(90), kind: 'full', status: 'done', pool: 'forks', testsRun: 100, suiteTotal: 100, wallMs: 1 },                // outside --since
    { t: 'tokens', at: at(1), tokens: 5 },
  ];
  const m = measuredFrom(recs, { since: '30d', now });
  assert.equal(m.runs, 5);
  assert.equal(m.suitePool, 'forks', 'the forks full run is the baseline');
  assert.equal(m.suiteMin, 200000 / 60000);
  assert.equal(m.selected, 0.2);            // median of 0.1 and 0.3
  assert.equal(Math.round(m.runAll * 1000) / 1000, 0.333);
  assert.equal(m.poolGain, 0.5);            // 100 s vs 200 s
  assert.equal(m.localDays, 4);
  assert.equal(measuredFrom(recs, { since: '1h', now }).runs, 0);
});

test('savings estimate: --shards 0 is rejected, runner minutes are shards × wall time', () => {
  assert.throws(() => parse(['--suite-min', '3', '--shards', '0']), /at least 1/);
  const e = estimate(parse(['--suite-min', '5', '--shards', '4', '--selected', '0.1', '--run-all', '0', '--overhead', '0', '--ci-runs', '1', '--days', '1']));
  assert.equal(e.month.ciRunnerMinutes, 16); // before 4 jobs × 5 min = 20, after 4 × ceil(0.5) = 4
  assert.ok(Number.isFinite(e.month.ciUsd));
});

test('savings estimate --from-measured: mixed isolated+vm label is a fast pool; clean runs preferred; explicit --pool-gain used', async () => {
  const { measuredFrom, isFastPool } = await import('../savings-estimate.mjs');
  assert.ok(isFastPool('vitest-guard:isolated+vm +quarantine'));
  assert.ok(isFastPool('vitest-guard:shared'));
  assert.ok(!isFastPool('vitest-guard:isolated +quarantine'));
  assert.ok(!isFastPool('forks'));
  const now = Date.parse('2026-11-22T12:00:00Z');
  const at = (d) => new Date(now - d * 864e5).toISOString();
  const full = (d, pool, wallMs, instrumented) => ({ t: 'run', at: at(d), kind: 'full', status: 'done', pool, testsRun: 100, suiteTotal: 100, wallMs, instrumented });
  const m = measuredFrom([full(5, 'forks', 200000, false), full(4, 'vitest-guard:isolated+vm', 100000, false), full(1, 'vitest-guard:vm', 400000, true)], { now });
  assert.equal(m.poolGain, 0.5);
  assert.equal(m.suitePool, 'forks');
  assert.equal(m.suiteInstrumented, false, 'the instrumented vm run is not mixed in');
  assert.equal(measuredFrom([full(4, 'vitest-guard:isolated+vm', 100000, false)], { now }).suitePool, 'vitest-guard:isolated+vm');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-sav-'));
  try {
    fs.mkdirSync(path.join(dir, '.vto'));
    const recent = (r, ago) => ({ ...r, at: new Date(Date.now() - ago).toISOString() });
    const recs = [recent(full(0, 'vitest-guard:vm', 100000, false), 60000)]; // only a fast-pool full run: converted with the explicit gain
    fs.writeFileSync(path.join(dir, '.vto', 'metrics.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const o = parse(['--from-measured', dir, '--pool-gain', '0.2']);
    assert.equal(Math.round(o['suite-min'] * 1000) / 1000, Math.round((100 / 60 / 0.8) * 1000) / 1000, 'converted with the explicit gain');
    assert.equal(o['pool-gain'], 0.2);
    assert.match(o.sources['local-runs'] || '', /AI-agent runs included/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('savings estimate --from-measured: overhead is measured, baseline is the forks full run (real-suite numbers)', async () => {
  const { measuredFrom } = await import('../savings-estimate.mjs');
  const now = Date.parse('2026-11-22T12:00:00Z');
  const at = (h) => new Date(now - h * 36e5).toISOString();
  const run = (h, kind, pool, testsRun, wallMs) => ({ t: 'run', at: at(h), kind, status: 'done', pool, testsRun, suiteTotal: 1000, wallMs, instrumented: false });
  const recs = [run(10, 'full', 'forks', 1000, 368000), run(9, 'full', 'vitest-guard:vm', 1000, 57000),
    run(2, 'affected', 'vitest-guard:vm', 50, 2600), run(1, 'affected', 'vitest-guard:vm', 50, 2200), run(1, 'affected', 'vitest-guard:vm', 50, 2600)];
  const m = measuredFrom(recs, { now });
  assert.equal(m.suitePool, 'forks');
  assert.equal(Math.round(m.suiteMin * 60), 368);
  assert.equal(m.overhead, 0, '2.6 s is below the 5 % share of 57 s (2.85 s): clamped to 0, not the hidden 0.5 min');
  assert.ok(Math.abs(m.poolGain - (1 - 57 / 368)) < 1e-9);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-sav-'));
  try {
    fs.mkdirSync(path.join(dir, '.vto'));
    fs.writeFileSync(path.join(dir, '.vto', 'metrics.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const o = parse(['--from-measured', dir, '--since', '30d']);
    assert.equal(o.overhead, 0);
    assert.match(o.sources.overhead, /measured/);
    const e = estimate(o);
    assert.ok(e.perRun.share > 0.9, `saving ${e.perRun.share}`);
    assert.ok(e.month.ciRunnerMinutes > 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
