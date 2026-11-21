import { it, expect } from 'vitest';
import legacy from '../src/legacy.cjs';
it('legacy exports clamp', () => { expect(typeof legacy.clamp).toBe('function'); });
