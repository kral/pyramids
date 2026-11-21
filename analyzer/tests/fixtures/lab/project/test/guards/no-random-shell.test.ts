import { it, expect } from 'vitest';
import { execSync } from 'node:child_process';
it('no file under src uses Math.random (grep in a child process)', () => {
  expect(execSync('grep -rl "Math.random" src || true', { encoding: 'utf8' }).trim()).toBe('');
});
