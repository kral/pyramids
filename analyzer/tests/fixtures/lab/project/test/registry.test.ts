import { it, expect } from 'vitest';
import { pluginNames } from '../src/registry';
it('only plugin a is registered', () => { expect(pluginNames()).toEqual(['a']); });
