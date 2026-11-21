import { it, expect } from 'vitest';
import { price } from '../src/price';
it('early vip check', () => { expect(price(1, 10, true)).toBe(7.2); });
it('slow vip check', async () => {
  await new Promise((r) => setTimeout(r, Number(process.env.VTO_FIXTURE_SLOW_MS || 2500)));
  expect(price(2, 10, true)).toBe(14.4);
}, 20000);
