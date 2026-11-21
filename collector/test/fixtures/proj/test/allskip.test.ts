import { expect, it } from 'vitest';
import { label } from '../src/label';
it.skipIf(!process.env.VTO_FIXTURE_FULL)('only in full mode', () => { expect(label(5)).toBe('n=5'); });
