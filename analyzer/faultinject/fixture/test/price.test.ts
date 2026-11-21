import { describe, it, expect } from 'vitest';
import { price, format } from '../src/index';
describe('price', () => {
  it('basic', () => { expect(price(10, 2)).toBe(20); });
  it('bulk discount', () => { expect(price(10, 10)).toBe(90); });
  it('almost bulk', () => { expect(price(10, 9)).toBe(90); });
  it('vip bulk', () => { expect(price(10, 10, true)).toBe(72); });
  it('throws on zero', () => { expect(() => price(1, 0)).toThrow('qty'); });
  it.each([[1, 1, 1], [2, 3, 6]])('each %i×%i', (b, q, r) => { expect(price(b, q)).toBe(r); });
});
describe('format', () => {
  it('formats', () => { expect(format(1)).toBe('1.00 Kč'); });
  it('rounds', () => { expect(format(1.005)).toBe('1.00 Kč'); });
});
