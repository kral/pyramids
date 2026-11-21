import { it, expect } from 'vitest';
import { clampQty } from '../src/uses-legacy';
it('clamps to 10', () => { expect(clampQty(50)).toBe(10); });
