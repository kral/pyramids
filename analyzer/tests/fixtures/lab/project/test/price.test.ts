import { describe, it, expect } from 'vitest';
import { price, format } from '../src/price';
describe('price', () => {
  it('basic', () => { expect(price(10, 2)).toBe(20); });
  it('basic again', () => { expect(price(5, 3)).toBe(15); });
  it('bulk discount', () => { expect(price(10, 10)).toBe(90); });
  it('vip bulk', () => { expect(price(10, 10, true)).toBe(72); });
  it('throws on zero', () => { expect(() => price(1, 0)).toThrow(); });
});
describe('format', () => {
  it('formats', () => { expect(format(1)).toBe('1.00 Kč'); });
});
