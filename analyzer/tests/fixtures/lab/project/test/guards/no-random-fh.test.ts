import { it, expect } from 'vitest';
import { open } from 'node:fs/promises';
it('src/price.ts never uses Math.random (FileHandle read)', async () => {
  const fh = await open('src/price.ts'); const src = await fh.readFile('utf8'); await fh.close();
  expect(src).not.toContain('Math.random');
});
