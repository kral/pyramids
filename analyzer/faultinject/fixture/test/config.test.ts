import { test, expect } from 'vitest';
import { TABLE, LIMITS, NAMES, clamp } from '../src/config';
test('table', () => { expect(TABLE).toEqual([0, 1, 4, 9, 16]); });
test('limits', () => { expect(LIMITS).toEqual({ min: 1, max: 50 }); });
test('names', () => { expect(NAMES.join()).toBe('alpha,beta,gamma'); });
test('clamp low', () => { expect(clamp(-5)).toBe(1); });
test('clamp high', () => { expect(clamp(99)).toBe(50); });
test('clamp mid', () => { expect(clamp(7)).toBe(7); });
