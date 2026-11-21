import { it, expect } from 'vitest';
import { greet } from '../src/lib.mjs';
it('greet returns a string', () => { expect(typeof greet('x')).toBe('string'); });
