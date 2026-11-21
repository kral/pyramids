import { it, expect, vi, beforeEach } from 'vitest';
beforeEach(() => { vi.resetModules(); });
it('tax uses the configured rate (module loaded lazily, like env-dependent config tests)', async () => {
  const m = await import('../src/config');
  expect(m.tax(100)).toBe(20);
});
