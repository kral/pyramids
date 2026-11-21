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
