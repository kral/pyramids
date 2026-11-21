import { it, expect } from 'vitest';
import { columns, cell } from '../src/columns';
it('renders cells', () => { expect(cell(0, { name: 'a' })).toBe('a'); });
