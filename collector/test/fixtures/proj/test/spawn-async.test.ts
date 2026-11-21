import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
it('cli greets (async)', async () => { expect((await promisify(execFile)(process.execPath, ['bin/cli.mjs', 'al'])).stdout.trim()).toBe('hello al'); });
