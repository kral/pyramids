import { expect, it } from 'vitest';
import { label } from '../src/label';
import { tax } from '../src/config';
it('fails before reaching label', () => { expect(tax(10)).toBe(999); expect(label(7)).toBe('n=7'); });
it('passes', () => { expect(tax(10)).toBe(2); });
