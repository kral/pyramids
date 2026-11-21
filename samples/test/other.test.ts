import { it, expect } from 'vitest';
import { price } from '../src/price';
it('duplicate of basic in other file', () => { expect(price(2, 2)).toBe(4); });
