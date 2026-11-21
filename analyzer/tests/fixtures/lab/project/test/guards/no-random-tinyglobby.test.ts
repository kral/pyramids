import { it, expect } from 'vitest';
import { globSync } from 'tinyglobby';
import { readFileSync } from 'node:fs';
it('no file under src uses Math.random (tinyglobby)', () => {
  for (const f of globSync('src/**/*.ts')) expect(readFileSync(f, 'utf8'), f).not.toContain('Math.random');
});
