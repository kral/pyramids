import { expect, it } from 'vitest';
import { label } from '../src/label';
import { before } from '../src/broken';
it('never collected', () => { expect(label(before)).toBe('n=1'); });
