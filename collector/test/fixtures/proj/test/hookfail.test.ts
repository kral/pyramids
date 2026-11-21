import { beforeAll, expect, it } from 'vitest';
import { label } from '../src/label';
beforeAll(() => { throw new Error('suite setup failed'); });
it('never runs', () => { expect(label(6)).toBe('n=6'); });
