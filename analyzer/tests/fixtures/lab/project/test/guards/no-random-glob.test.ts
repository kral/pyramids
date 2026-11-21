import { it, expect } from 'vitest';
import fs from 'node:fs';
it('no file under src uses Math.random (fs.globSync + readFileSync)', () => {
  for (const f of fs.globSync('src/**/*.ts')) expect(fs.readFileSync(f, 'utf8'), f).not.toContain('Math.random');
});
