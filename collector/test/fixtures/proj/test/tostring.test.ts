import { expect, it } from 'vitest';
import { double, runSerialized } from '../src/serialized';
it('serialised function still runs (vto-ignore-file)', () => { expect(runSerialized(double, 21)).toBe(42); });
