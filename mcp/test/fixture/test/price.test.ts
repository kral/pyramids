import { describe, it, expect } from 'vitest';
import { price } from '../src/price';
describe('price', () => {
  it('basic', () => { expect(price(10, 2)).toBe(20); });
  it('bulk', () => { expect(price(10, 10)).toBe(90); });
  it('vip', () => { expect(price(10, 10, true)).toBe(72); });
  it('throws on zero', () => { expect(() => price(1, 0)).toThrow(); });
});
