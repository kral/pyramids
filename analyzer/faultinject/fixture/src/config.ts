import data from './data.json';
function buildTable(n: number): number[] {
  const t: number[] = [];
  for (let i = 0; i < n; i++) {
    t.push(i * i);
  }
  return t;
}
export const TABLE = buildTable(5);
export const LIMITS = { min: 1, max: data.max };
export const NAMES = ['alpha', 'beta', 'gamma'];
export function clamp(v: number) {
  return Math.min(LIMITS.max, Math.max(LIMITS.min, v));
}
