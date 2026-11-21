import { beforeEach, expect, it, vi } from 'vitest';
beforeEach(() => { vi.resetModules(); });
it('tax uses the configured rate', async () => { const m = await import('../src/config'); expect(m.tax(100)).toBe(20); });
