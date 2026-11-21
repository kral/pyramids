// A4 (VALIDATION-real-suite): only incompatible.json / conflicts.json are committed state; everything volatile
// lives in .vitest-guard/run/ with a `*` .gitignore, unchanged files are not rewritten, old layouts are migrated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vmg-state-'));

test('A4: volatile state goes to .vitest-guard/run/ (git-ignored), committed files stay in .vitest-guard/', async () => {
  const { ctx, statePath, saveState } = await import('../src/cli.mjs');
  const root = mk();
  const c = ctx({ _: ['plan'], root });
  for (const n of ['durations.json', 'pollution.json', 'plan.json', 'files-cache.json', 'settings.json', 'verify-vm.json', 'compare.json'])
    assert.equal(path.dirname(statePath(c, n)), path.join(root, '.vitest-guard', 'run'), n);
  for (const n of ['incompatible.json', 'conflicts.json']) assert.equal(path.dirname(statePath(c, n)), path.join(root, '.vitest-guard'), n);
  saveState(c, 'durations.json', { a: 1 });
  assert.equal(fs.readFileSync(path.join(root, '.vitest-guard/run/.gitignore'), 'utf8').trim().split('\n').at(-1), '*');
  assert.equal(c.runDir, path.join(root, '.vitest-guard', 'run', 'logs'));
  const committed = ctx({ _: ['plan'], root, 'commit-state': true });
  assert.equal(path.dirname(statePath(committed, 'durations.json')), path.join(root, '.vitest-guard'));
  assert.equal(path.dirname(statePath(committed, 'plan.json')), path.join(root, '.vitest-guard', 'run'));
});

test('A4: unchanged content does not touch the committed file', async () => {
  const { ctx, saveState, statePath } = await import('../src/cli.mjs');
  const root = mk();
  const c = ctx({ _: ['check'], root });
  saveState(c, 'incompatible.json', { version: 1, vm: {}, shared: {} });
  const f = statePath(c, 'incompatible.json');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(f, old, old);
  saveState(c, 'incompatible.json', { version: 1, vm: {}, shared: {} });
  assert.equal(Math.floor(fs.statSync(f).mtimeMs / 1000), Math.floor(old.getTime() / 1000));
});

test('A4: volatile files of the old layout are moved into run/, committed ones stay', async () => {
  const { ctx, migrateState } = await import('../src/cli.mjs');
  const root = mk();
  const d = path.join(root, '.vitest-guard');
  fs.mkdirSync(path.join(d, 'run'), { recursive: true });
  for (const n of ['incompatible.json', 'conflicts.json', 'durations.json', 'pollution.json', 'plan.json', 'files-cache.json', 'settings.json', 'verify-vm.json']) fs.writeFileSync(path.join(d, n), '{}');
  fs.writeFileSync(path.join(d, 'run', 'w-1-1.jsonl'), '');
  const log = console.log; console.log = () => {};
  try { migrateState(ctx({ _: ['check'], root })); } finally { console.log = log; }
  assert.deepEqual(fs.readdirSync(d).sort(), ['conflicts.json', 'incompatible.json', 'run']);
  assert.deepEqual(fs.readdirSync(path.join(d, 'run')).sort(), ['.gitignore', 'durations.json', 'files-cache.json', 'plan.json', 'pollution.json', 'settings.json', 'verify-vm.json']);
});
