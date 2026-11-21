import { test, expect } from 'vitest';
import { discount, kind, RATE } from '../src/disc';
test('big order', () => { expect(discount(20)).toBe(15); });
test('small order', () => { expect(discount(3)).toBe(3); });
test('boundary order', () => { expect(discount(10)).toBe(10); });
test('kind one', () => { expect(kind(1)).toBe('one'); });
test('kind two', () => { expect(kind(2)).toBe('two'); });
test('kind three', () => { expect(kind(3)).toBe('other'); });
test('rate constant', () => { expect(RATE * 100).toBe(21); });
