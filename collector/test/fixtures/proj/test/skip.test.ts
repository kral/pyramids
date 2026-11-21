import { describe, expect, it } from 'vitest';
import { label } from '../src/label';
it('runs', () => { expect(label(2)).toBe('n=2'); });
it.skip('skipped', () => { expect(label(3)).toBe('x'); });
it.todo('todo later');
it.runIf(process.env.VTO_FIXTURE_FULL)('ci only', () => { expect(label(4)).toBe('n=4'); });
describe.skip('skipped suite', () => { it('inner', () => {}); });
