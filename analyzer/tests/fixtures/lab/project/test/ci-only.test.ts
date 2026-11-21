import { it, expect } from 'vitest';
import { format } from '../src/price';
it('format returns a string', () => { expect(typeof format(1)).toBe('string'); });
it.runIf(process.env.FULL)('format exact (only in the full/CI configuration)', () => { expect(format(2)).toBe('2.00 Kč'); });
