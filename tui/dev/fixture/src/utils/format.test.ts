import { describe, it, expect } from 'vitest';
import { formatPrice, formatDate } from './format';

describe('formatPrice', () => {
  it('formats thousands with a space and decimal comma', () => {
    expect(formatPrice(1234.5)).toBe('1 234,50 Kč');
  });

  it('formats zero', () => {
    expect(formatPrice(0)).toBe('0,00 Kč');
  });
});

describe('formatDate', () => {
  it('formats Czech date', () => {
    expect(formatDate(new Date(2026, 10, 21))).toBe('21. 11. 2026');
  });
});
