import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export function clampQty(n: number): number {
  return require('./legacy.cjs').clamp(n);
}
