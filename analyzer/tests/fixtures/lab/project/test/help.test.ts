import { it, expect } from 'vitest';
import { helpText } from '../src/help';
it('help text comes from the README', () => { expect(helpText()).toBe('Supported: price, format'); });
