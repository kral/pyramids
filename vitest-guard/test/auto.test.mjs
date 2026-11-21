import { fileURLToPath } from 'node:url';
// mode 'auto': classification, generated dom/node projects, stored modes, probe + self-healing of misclassified files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { staticGroup, classifyFiles, listTestFiles, readEnvEvidence } from '../src/auto.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
import { integration, vitestDir } from './helpers.mjs'; // no silent skip: fails without vitest unless VITEST_GUARD_TEST_NO_INTEGRATION=1

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vmg-auto-'));
  for (const [f, src] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), src); }
  if (vitestDir) fs.symlinkSync(vitestDir, path.join(root, 'node_modules'));
  return root;
}

test('auto: static classification', () => {
  assert.equal(staticGroup('a.test.tsx', '').group, 'dom');
  assert.equal(staticGroup('a.test.ts', "import { render } from '@testing-library/react'").group, 'dom');
  assert.equal(staticGroup('a.test.ts', "import userEvent from '@testing-library/user-event'").group, 'dom');
  assert.equal(staticGroup('a.test.ts', "const { renderHook } = x; renderHook(() => 1)").group, 'dom');
  assert.equal(staticGroup('a.test.ts', "document.body.innerHTML = ''").group, 'dom');
  assert.equal(staticGroup('a.test.ts', "import { sum } from '../src/sum'; it('x', () => {})").group, 'node');
  assert.equal(staticGroup('a.test.ts', "// document.body in a comment\nimport { sum } from './s'").group, 'node');
  const p = staticGroup('a.test.tsx', '/** @vitest-environment node */\nimport x from "y"');
  assert.equal(p.group, 'node'); assert.equal(p.pragma, 'node');
  assert.equal(staticGroup('a.test.ts', '// @vitest-environment happy-dom\n').group, 'dom');
});

test('auto: evidence order - pragma > DOM miss > own probe > vto > static; configured node env keeps all in node', () => {
  const root = project({ 'n.test.ts': 'it()', 'd.test.ts': "import '@testing-library/jest-dom'", 'p.test.tsx': '// @vitest-environment node\n', 'm.test.ts': 'it()', 'v.test.ts': 'it()' });
  fs.mkdirSync(path.join(root, '.vitest-guard/run'), { recursive: true });
  fs.writeFileSync(path.join(root, '.vitest-guard/run/env-1-1.jsonl'), [
    { t: 'env', file: 'd.test.ts', dom: false }, { t: 'env-miss', file: 'm.test.ts', key: 'document' }, { t: 'env', file: 'm.test.ts', dom: false },
    { t: 'env', file: 'p.test.tsx', dom: true }].map((r) => JSON.stringify(r)).join('\n'));
  // an entry written by another producer (vto daemon) must survive our folding
  fs.writeFileSync(path.join(root, '.vitest-guard/run/env.json'), JSON.stringify({ format: 'vto-env/1', producer: 'vto-daemon', updatedAt: 'x', files: { 'other/x.test.ts': { group: 'node', source: 'probe', env: 'jsdom', dom: false, at: 'x' } } }));
  fs.mkdirSync(path.join(root, '.vto/raw/main'), { recursive: true });
  fs.writeFileSync(path.join(root, '.vto/raw/main/env-1-1.jsonl'), JSON.stringify({ t: 'env', testFile: path.join(root, 'v.test.ts'), env: 'jsdom', dom: true }) + '\n');
  const files = listTestFiles(root, ['**/*.test.{ts,tsx}'], ['**/node_modules/**']);
  assert.deepEqual(files, ['d.test.ts', 'm.test.ts', 'n.test.ts', 'p.test.tsx', 'v.test.ts']);
  const def = classifyFiles(root, files, 'jsdom');
  assert.deepEqual(def.node, ['p.test.tsx'], 'default: route by configured environment (only the node pragma leaves dom)');
  const doc = JSON.parse(fs.readFileSync(path.join(root, '.vitest-guard/run/env.json'), 'utf8'));
  assert.equal(doc.format, 'vto-env/1');
  assert.deepEqual(doc.files['other/x.test.ts'].source, 'probe', 'other producer entry kept');
  assert.equal(doc.files['m.test.ts'].group, 'dom'); assert.equal(doc.files['d.test.ts'].group, 'node');
  const r = classifyFiles(root, files, 'jsdom', { nodeEnvironment: 'node' });
  assert.deepEqual(r.dom.sort(), ['m.test.ts', 'v.test.ts']);
  assert.deepEqual(r.node.sort(), ['d.test.ts', 'n.test.ts', 'p.test.tsx']);
  assert.match(r.why['m.test.ts'], /failed in node group/);
  assert.match(r.why['d.test.ts'], /never touched DOM/);
  assert.match(r.why['p.test.tsx'], /pragma/);
  assert.ok(!fs.readdirSync(path.join(root, '.vitest-guard/run')).some((n) => n.startsWith('env-')), 'records folded into env.json');
  assert.deepEqual(readEnvEvidence(root)['m.test.ts'].miss, { key: 'document' }, 'miss is sticky');
  assert.deepEqual(classifyFiles(root, files, 'node', { nodeEnvironment: 'node' }).dom, [], 'configured node environment: nothing moves to dom without a pragma');
});

test('auto: generated projects, stored modes, overrides, user projects keep their split', async () => {
  const { defineVitestGuardConfig } = await import('../src/index.mjs');
  const root = project({ 'test/ui.test.tsx': '', 'test/logic.test.ts': "import { x } from '../src/x'", 'test/pure.test.ts': '// @vitest-environment node\nit()' });
  const proj = (cfg, n) => cfg.test.projects.find((p) => p.test.name === n);
  let cfg = defineVitestGuardConfig({ root, test: { environment: 'jsdom', include: ['test/**/*.test.{ts,tsx}'] } }, { mode: 'auto' });
  assert.deepEqual(proj(cfg, 'dom').test.include, ['test/logic.test.ts', 'test/ui.test.tsx'], 'default: configured environment decides');
  assert.deepEqual(proj(cfg, 'node').test.include, ['test/pure.test.ts']);
  assert.equal(proj(cfg, 'node').test.provide.vitestGuardAutoHeal, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.vitest-guard/run/auto.json'), 'utf8')).groups, { dom: 'vm', node: 'shared' });
  cfg = defineVitestGuardConfig({ root, test: { environment: 'jsdom', include: ['test/**/*.test.{ts,tsx}'] } }, { mode: 'auto', nodeEnvironment: 'node' });
  assert.deepEqual(proj(cfg, 'dom').test.include, ['test/ui.test.tsx']);
  assert.equal(proj(cfg, 'dom').test.pool, 'vmThreads');
  assert.deepEqual(proj(cfg, 'node').test.include, ['test/logic.test.ts', 'test/pure.test.ts']);
  assert.equal(proj(cfg, 'node').test.environment, 'node');
  assert.equal(proj(cfg, 'node').test.provide.vitestGuardAutoHeal, true);
  assert.equal(proj(cfg, 'node').test.pool, 'threads'); assert.equal(proj(cfg, 'node').test.isolate, false);
  assert.equal(proj(cfg, 'node').test.provide.vitestGuardAuto, 'node');
  assert.equal(cfg.test.include, undefined, 'no root include (would be merged into both projects)');
  fs.mkdirSync(path.join(root, '.vitest-guard/run'), { recursive: true });
  fs.writeFileSync(path.join(root, '.vitest-guard/run/modes.json'), JSON.stringify({ modes: { dom: 'shared', node: 'isolated' } }));
  cfg = defineVitestGuardConfig({ root, test: { environment: 'jsdom', include: ['test/**/*.test.{ts,tsx}'] } }, { mode: 'auto', nodeEnvironment: 'node' });
  assert.equal(proj(cfg, 'dom').test.isolate, false); assert.equal(proj(cfg, 'node').test.pool, 'forks');
  cfg = defineVitestGuardConfig({ root, test: { environment: 'jsdom', include: ['test/**/*.test.{ts,tsx}'] } }, { mode: 'auto', nodeEnvironment: 'node', autoModes: { node: 'vm' } });
  assert.equal(proj(cfg, 'node').test.pool, 'vmThreads', 'autoModes override stored modes');
  // user projects: split kept, mode chosen per project from its environment
  fs.rmSync(path.join(root, '.vitest-guard/run/modes.json'));
  cfg = defineVitestGuardConfig({ root, test: { projects: [
    { extends: true, test: { name: 'ui', environment: 'jsdom', pool: 'vmThreads', include: ['test/**/*.test.tsx'] } },
    { extends: true, test: { name: 'logic', environment: 'node', pool: 'vmThreads', include: ['test/**/*.test.ts'] } }] } }, { mode: 'auto' });
  assert.equal(proj(cfg, 'ui').test.pool, 'vmThreads');
  assert.equal(proj(cfg, 'logic').test.pool, 'threads', 'node project: shared by default');
  assert.deepEqual(proj(cfg, 'logic').test.include, ['test/**/*.test.ts']);
  cfg = defineVitestGuardConfig({ root, test: { projects: [{ extends: true, test: { name: 'logic', environment: 'node', pool: 'vmThreads' } }] } }, { mode: 'auto', respectPools: true });
  assert.equal(proj(cfg, 'logic').test.pool, 'vmThreads');
});

test('auto end to end: a hidden DOM user fails in node with a clear message, then moves to dom; probe demotes a file that never touches the DOM', integration, async () => {
  const root = project({
    'package.json': '{"type":"module"}',
    'vitest.config.mjs': `import { defineVitestGuardConfig } from '${path.join(here, '..', 'src', 'index.mjs')}';\n// the temp project links node_modules from outside its root: let Vite serve it (real installs live inside the root)
export default defineVitestGuardConfig({ server: { fs: { strict: false } }, test: { environment: 'jsdom', include: ['test/**/*.test.ts'] } }, { mode: 'auto', nodeEnvironment: 'node' });\n`,
    'src/title.js': 'export const setTitle = (t) => { globalThis.document.title = t; return document.title; };\n',
    'test/hidden-dom.test.ts': `import { it, expect } from 'vitest';\nimport { setTitle } from '../src/title.js';\nit('sets title', () => { expect(setTitle('x')).toBe('x'); });\n`,
    'test/pure.test.ts': `import { it, expect } from 'vitest';\nit('adds', () => { expect(1 + 1).toBe(2); });\n`,
    // statically "uses document" (so it starts in the dom group) but never touches the DOM at runtime
    'test/dom-import-only.test.ts': `import { it, expect } from 'vitest';\nit('no dom used', () => { expect([1].length).toBe(1); });\nit.skip('later', () => { document.body.innerHTML = ''; });\n`,
  });
  const { runVitest } = await import('../src/runner.mjs');
  const cfg = path.join(root, 'vitest.config.mjs');
  const r1 = await runVitest({ root, config: cfg, tag: 'auto1' });
  assert.equal(r1.files.get('test/hidden-dom.test.ts')?.status, 'failed');
  assert.match(r1.log + (r1.files.get('test/hidden-dom.test.ts')?.message || ''), /classified as pure node/);
  assert.equal(r1.files.get('test/pure.test.ts')?.status, 'passed');
  const r2 = await runVitest({ root, config: cfg, tag: 'auto2' });
  assert.equal(r2.files.get('test/hidden-dom.test.ts')?.status, 'passed', 'self-healed: runs in the dom group now');
  const env = JSON.parse(fs.readFileSync(path.join(root, '.vitest-guard/run/env.json'), 'utf8')).files;
  assert.equal(env['test/hidden-dom.test.ts'].source, 'probe'); assert.equal(env['test/hidden-dom.test.ts'].miss.key, 'document');
  assert.equal(env['test/dom-import-only.test.ts']?.dom, false, 'probe: started in dom (static) but never touched the DOM');
  const { classifyFiles: cf } = await import('../src/auto.mjs');
  assert.ok(cf(root, ['test/dom-import-only.test.ts'], 'jsdom', { nodeEnvironment: 'node' }).node.includes('test/dom-import-only.test.ts'), 'demoted to node by measurement');
  const r3 = await runVitest({ root, config: cfg, tag: 'auto3' });
  for (const f of ['test/hidden-dom.test.ts', 'test/pure.test.ts', 'test/dom-import-only.test.ts']) assert.equal(r3.files.get(f)?.status, 'passed', f);
});
