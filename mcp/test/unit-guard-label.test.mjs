import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeGuard, guardLabel } from '../src/guard-label.mjs';

const proj = (name, mode) => ({ name, provide: mode ? { vitestGuard: { mode } } : {} });

test('guard label: the quarantine sibling never decides the mode (it used to win as the last project)', () => {
  // single config: vitest-guard:vm + vitest-guard:isolated (quarantine)
  assert.deepEqual(summarizeGuard([proj('vitest-guard:vm', 'vm'), proj('vitest-guard:isolated', 'isolated')]), { mode: 'vm', quarantine: true });
  // user projects: app (vm) + app:isolated, lib (shared) + lib:isolated
  assert.deepEqual(summarizeGuard([proj('app', 'vm'), proj('app:isolated', 'isolated'), proj('lib', 'shared'), proj({ label: 'lib:isolated' }, 'isolated')]), { mode: 'shared+vm', quarantine: true });
  // no quarantine, everything isolated on purpose, not guarded
  assert.deepEqual(summarizeGuard([proj('vitest-guard:vm', 'vm')]), { mode: 'vm', quarantine: false });
  assert.deepEqual(summarizeGuard([proj('unit', 'isolated')]), { mode: 'isolated', quarantine: false });
  assert.equal(summarizeGuard([proj('unit')]), null);
  assert.equal(guardLabel({ pool: 'vmThreads', vitestGuard: 'vm', vitestGuardQuarantine: true }), 'vitest-guard:vm +quarantine');
  assert.equal(guardLabel({ pool: 'forks', vitestGuard: null }), 'forks');
  assert.equal(guardLabel(null), null);
});
