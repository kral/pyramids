import { it, expect } from 'vitest';
import { name } from '../src/disabled/extra';
it('extra has a name', () => { expect(name).toBe('extra'); });
