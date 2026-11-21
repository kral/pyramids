import { it, expect } from 'vitest';
import { openPage } from '../src/app';
it('app opens the lazy page with its title', async () => { expect(await openPage()).toBe('<h1>Orders</h1>'); });
