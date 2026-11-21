export function discount(total: number) {
  let d = 0;
  if (total > 10) {
    d = 5;
  }
  return total - d;
}
export function kind(x: number) {
  switch (x) {
    case 1:
      return 'one';
    case 2:
      return 'two';
  }
  return 'other';
}
export const RATE = 0.21;
