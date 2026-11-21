import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { s } from '../src/static';
beforeEach(async () => { expect((await import('../src/hook')).hook()).toBe('hook'); });
afterAll(async () => { expect((await import('../src/late')).late()).toBe('late'); });
it('static import', () => { expect(s()).toBe('static'); });
it('lazy json', async () => { expect((await import('../src/data.json')).default.limit).toBe(3); });
it('json then resetModules', async () => {
  expect((await import('../src/reset.json')).default.again).toBe(1);
  vi.resetModules();
});
