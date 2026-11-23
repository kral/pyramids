// Only incompatible.json / conflicts.json are committed state; everything volatile lives in .vitest-guard/run/
// with a `*` .gitignore, unchanged files are not rewritten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mk = () => fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'vmg-state-'));

test('A4: volatile state goes to .vitest-guard/run/ (git-ignored), committed files stay in .vitest-guard/', async () => {
  const { ctx, statePath, saveState } = await import('../src/cli.mjs');
  const root = mk();
  const c = ctx({ _: ['check'], root });
  for (const n of ['verify-vm.json', 'verify-shared.json', 'compare.json'])
    assert.equal(path.dirname(statePath(c, n)), path.join(root, '.vitest-guard', 'run'), n);
  for (const n of ['incompatible.json', 'conflicts.json']) assert.equal(path.dirname(statePath(c, n)), path.join(root, '.vitest-guard'), n);
  saveState(c, 'compare.json', { a: 1 });
  assert.equal(fs.readFileSync(path.join(root, '.vitest-guard/run/.gitignore'), 'utf8').trim().split('\n').at(-1), '*');
  assert.equal(c.runDir, path.join(root, '.vitest-guard', 'run', 'logs'));
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
