import { expect, it } from 'vitest';
import { label } from '../src/label';
it('label', () => { expect(label(1)).toBe('n=1'); });
