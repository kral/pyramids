import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as api from '../src/price';
it('docs/api.md documents every export', () => {
  const md = readFileSync('docs/api.md', 'utf8');
  for (const name of Object.keys(api)) expect(md).toContain(name + '(');
});
