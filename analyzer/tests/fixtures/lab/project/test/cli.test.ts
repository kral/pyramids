import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
it('cli prints the greeting', () => {
  expect(execFileSync(process.execPath, ['bin/cli.mjs', 'bob'], { encoding: 'utf8' }).trim()).toBe('hello bob');
});
