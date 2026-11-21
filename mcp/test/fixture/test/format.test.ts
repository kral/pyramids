import { it, expect } from 'vitest';
import { format } from '../src/format';
it('formats', () => { expect(format(1)).toBe('1.00 Kč'); });
it('logs a secret on failure path', () => { console.log('API_TOKEN=supersecret123'); expect(format(2)).toBe('2.00 Kč'); });
