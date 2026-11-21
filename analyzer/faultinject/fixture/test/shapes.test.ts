import { test, expect } from 'vitest';
import { Rect, parse, total } from '../src/shapes';
test('area', () => { expect(new Rect(2, 3).area).toBe(6); });
test('scale', () => { expect(new Rect(2, 3).scale(2).area).toBe(24); });
test('scale zero', () => { expect(() => new Rect(1, 1).scale(0)).toThrow(RangeError); });
test('parse ok', () => { expect(parse('{"w":1,"h":2}')?.area).toBe(2); });
test('parse bad', () => { expect(parse('nope')).toBeNull(); });
test('total', () => { expect(total([new Rect(1, 1), new Rect(2, 2)])).toBe(5); });
test('total empty', () => { expect(total([])).toBe(0); });
