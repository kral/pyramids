// Project detection helpers (no engine state).
import fs from 'node:fs';
import path from 'node:path';
import { userError } from './errors.mjs';

export function isVitestProject(root) {
  if (findConfig(root)) return true;
  try { const pj = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); if ({ ...pj.dependencies, ...pj.devDependencies }.vitest) return true; } catch {}
  return fs.existsSync(path.join(root, 'node_modules', 'vitest', 'package.json'));
}
export function findConfig(root) {
  for (const n of ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.cts', 'vitest.config.cjs', 'vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs']) {
    const p = path.join(root, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
export { userError };
