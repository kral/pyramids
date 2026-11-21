export const CURRENCY = 'Kč';
export function format(n: number): string {
  return n.toFixed(2) + ' ' + CURRENCY;
}
