import { expect, it } from 'vitest';
import { open } from '../src/app';
it('opens the lazy page', async () => { expect(await open()).toBe('<h1>Page</h1>'); });
