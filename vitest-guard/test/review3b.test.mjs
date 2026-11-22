// Regression tests for the third review round (correctness), second batch: S2 stale auto.json, S4 baseline before the
// first test file, S5 state the resets and the detector missed, S9 compare without a usable reference, S12 Windows paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, wrappedConfig, cli, vitestRun, integration, readJson } from './helpers.mjs';
import { verifyStatus, configKey, gitHead } from '../src/verifystate.mjs';

const pass = `import { test, expect } from 'vitest'; test('ok', () => { expect(1).toBe(1); });\n`;
const P = (files, t = {}, guard = {}) => project({ 'vitest.config.mjs': wrappedConfig(t, guard), 'package.json': '{"type":"module"}', ...files });

test('S2 unit: an auto verify record does not count for a config that runs in another mode', () => {
  const root = P({ 'src/a.test.js': pass });
  const cfg = path.join(root, 'vitest.config.mjs');
  fs.mkdirSync(path.join(root, '.vitest-guard/run'), { recursive: true });
  const rec = (mode) => fs.writeFileSync(path.join(root, '.vitest-guard/run/verify-shared.json'), JSON.stringify({ at: 'T', mode, head: gitHead(root), configKey: configKey(root, cfg), complete: true, falseGreen: [] }));
  rec('auto');
  assert.equal(verifyStatus(root, 'shared', { configFile: cfg, configMode: 'auto' }).ok, true);
  const st = verifyStatus(root, 'shared', { configFile: cfg, configMode: 'shared' });
  assert.equal(st.ok, false); assert.match(st.reason, /ran in mode auto, the config runs in mode shared/);
  rec('shared');
  assert.equal(verifyStatus(root, 'shared', { configFile: cfg, configMode: 'shared' }).ok, true);
  assert.equal(verifyStatus(root, 'shared', { configFile: cfg, configMode: 'vm' }).ok, true, 'a shared verify still covers shared projects of a vm config');
});

test('S2: a leftover auto.json does not make check / verify run in mode auto; an auto verify does not silence a shared run', integration, () => {
  const root = P({ 'src/a.test.js': pass }, {}, { mode: 'auto' });
  const v = cli(root, ['verify', '--no-calibrate']);
  assert.equal(v.code, 0, v.out);
  assert.match(v.out, /verify · auto/);
  assert.ok(fs.existsSync(path.join(root, '.vitest-guard/run/verify-shared.json')), 'auto with a shared group writes verify-shared.json');
  assert.doesNotMatch(vitestRun(root).out, /not verified/, 'the auto config itself is verified');
  // same config file, but the run is forced into shared mode: the auto record compared another pool layout
  assert.match(vitestRun(root, [], { env: { VITEST_GUARD_MODE: 'shared' } }).out, /not verified.*ran in mode auto/);
  // leave mode 'auto' (auto.json stays behind): the CLI follows the config, not the leftover file
  const cfg = path.join(root, 'vitest.config.mjs');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('"mode":"auto"', '"mode":"isolated"'));
  assert.ok(fs.existsSync(path.join(root, '.vitest-guard/run/auto.json')));
  const c = cli(root, ['check']);
  assert.doesNotMatch(c.out, /check · auto|auto: resolved mode/, c.out);
});
