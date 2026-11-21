import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8');
test('base font size', () => { expect(css).toMatch(/--font-size: 16px;/); });
test('line height', () => { expect(css).toMatch(/--line-height: 1\.5;/); });
