import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(m.suitePool, 'vitest-guard:vm');
  assert.equal(m.selected, 0.2);            // median of 0.1 and 0.3
  assert.equal(Math.round(m.runAll * 1000) / 1000, 0.333);
  assert.equal(m.poolGain, 0.5);            // 100 s vs 200 s
  assert.equal(m.localDays, 4);
  assert.equal(measuredFrom(recs, { since: '1h', now }).runs, 0);
});
