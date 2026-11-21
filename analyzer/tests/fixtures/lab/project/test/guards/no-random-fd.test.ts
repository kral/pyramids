import { it, expect } from 'vitest';
import fs from 'node:fs';
it('src/price.ts never uses Math.random (fd based read)', () => {
  const fd = fs.openSync('src/price.ts', 'r');
  const src = fs.readFileSync(fd, 'utf8'); fs.closeSync(fd);
  expect(src).not.toContain('Math.random');
});
