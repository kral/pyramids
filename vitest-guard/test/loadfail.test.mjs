// 0.1.0-alpha.5: files that fail to LOAD in a fast mode (ERR_VM_MODULE_DIFFERENT_CONTEXT) are named, not just counted as mismatches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { project, wrappedConfig, cli, integration, readJson } from './helpers.mjs';
import { runVitest, classifyLoadFailure, loadFailures } from '../src/runner.mjs';

test('classifyLoadFailure: code or message of the vm context error, nothing else', () => {
  assert.equal(classifyLoadFailure("Error: Linked modules must use the same context\n  code: 'ERR_VM_MODULE_DIFFERENT_CONTEXT'"), 'vm-context');
  assert.equal(classifyLoadFailure('code: ERR_VM_MODULE_DIFFERENT_CONTEXT'), 'vm-context');
  assert.equal(classifyLoadFailure('linked modules must use the same context'), 'vm-context');
  assert.equal(classifyLoadFailure("TypeError: Cannot read properties of null (reading '_location')"), null);
  assert.equal(classifyLoadFailure(''), null);
  assert.equal(classifyLoadFailure(undefined), null);
});

test('runVitest: synthetic JSON report: load failures get loadError, failures with tests do not (fail closed: all stay failed)', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vmg-lf-')));
  fs.mkdirSync(path.join(root, 'node_modules/vitest'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/vitest/package.json'), '{"name":"vitest","version":"4.1.8"}');
  const rep = { testResults: [
    { name: path.join(root, 'src/a.test.js'), status: 'failed', assertionResults: [], message: "Error: Linked modules must use the same context\n  code: 'ERR_VM_MODULE_DIFFERENT_CONTEXT'" },
    { name: path.join(root, 'src/b.test.js'), status: 'passed', assertionResults: [{ ancestorTitles: [], title: 't', status: 'passed' }], message: '' },
    { name: path.join(root, 'src/c.test.js'), status: 'failed', assertionResults: [{ ancestorTitles: [], title: 't', status: 'failed', failureMessages: ['Linked modules must use the same context'] }], message: '' },
    { name: path.join(root, 'src/d.test.js'), status: 'failed', assertionResults: [], message: "TypeError: Cannot read properties of null (reading '_location')" },
  ] };
  fs.writeFileSync(path.join(root, 'node_modules/vitest/vitest.mjs'), `import fs from 'node:fs'; const o = process.argv.find((a) => a.startsWith('--outputFile=')).slice(13); fs.writeFileSync(o, ${JSON.stringify(JSON.stringify(rep))}); process.exit(1);\n`);
  const r = await runVitest({ root, mode: 'vm' });
  assert.equal(r.files.get('src/a.test.js').status, 'failed');
  assert.equal(r.files.get('src/a.test.js').loadError, 'vm-context');
  assert.equal(r.files.get('src/b.test.js').loadError, undefined);
  assert.equal(r.files.get('src/c.test.js').loadError, undefined);
  assert.equal(r.files.get('src/d.test.js').loadError, undefined);
  assert.deepEqual(loadFailures(r.files), { 'vm-context': ['src/a.test.js'] });
  assert.deepEqual(loadFailures(r.files, ['src/b.test.js']), {});
});

const mk = () => project({
  'vitest.config.mjs': wrappedConfig({}),
  'package.json': '{"type":"module"}',
  'src/a.test.js': `import { test, expect } from 'vitest'; test('ok', () => { expect(1).toBe(1); });\n`,
  'src/b.test.js': `import { test, expect } from 'vitest';\nif (process.env.VITEST_GUARD_MODE === 'vm') { const e = new Error('Linked modules must use the same context'); e.code = 'ERR_VM_MODULE_DIFFERENT_CONTEXT'; throw e; }\ntest('ok', () => { expect(1).toBe(1); });\n`,
});

test('compare: names the load failures, explains them, keeps the recommendation and exit code', integration, () => {
  const root = mk();
  const r = cli(root, ['compare', '--sample', 'all']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 file fails to load: vm module context/, r.out);
  assert.match(r.out, /ERR_VM_MODULE_DIFFERENT_CONTEXT/);
  assert.match(r.out, /never ran|never run/);
  assert.match(r.out, /Vitest 5/);
  assert.match(r.out, /server\.deps\.inline/);
  const row = readJson(path.join(root, '.vitest-guard/run/compare.json')).rows[0];
  assert.deepEqual(row.vmLoad, { 'vm-context': ['src/b.test.js'] });
  assert.ok(row.vmMismatch > 0);
  assert.notEqual(row.recommend, 'vm');
});

test('check --mode vm: one line with code, count and files; the files still fail closed (quarantined after forks passes)', integration, () => {
  const root = mk();
  const r = cli(root, ['check', '--mode', 'vm']);
  assert.match(r.out, /vm: 1 file\(s\) failed to LOAD with ERR_VM_MODULE_DIFFERENT_CONTEXT .*src\/b\.test\.js/, r.out);
  assert.notEqual(r.code, 0, r.out); // a new quarantine entry (exit 4) or failure, never 0
});
