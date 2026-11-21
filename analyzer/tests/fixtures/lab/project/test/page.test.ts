import { it, expect } from 'vitest';
import { renderPage } from '../src/page';
it('page renders something', () => { expect(renderPage()).toContain('<h1>'); });
