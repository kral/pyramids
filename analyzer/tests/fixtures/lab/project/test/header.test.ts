import { it, expect } from 'vitest';
import { columns } from '../src/columns';
it('header labels', () => { expect(columns.map((c) => c.label)).toEqual(['Name', 'Qty']); });
