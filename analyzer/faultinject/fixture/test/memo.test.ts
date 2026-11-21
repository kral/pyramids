import { test, expect } from 'vitest';
import { fib } from '../src/memo';
test('fib 10', () => { expect(fib(10)).toBe(55); });
test('fib 10 cached', () => { expect(fib(10)).toBe(55); });
test('fib 9 cached', () => { expect(fib(9)).toBe(34); });
