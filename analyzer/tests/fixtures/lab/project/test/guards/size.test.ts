import { it, expect } from 'vitest';
import fs from 'node:fs';
it('docs/api.md stays short (statSync)', () => { expect(fs.statSync('docs/api.md').size).toBeLessThan(60); });
