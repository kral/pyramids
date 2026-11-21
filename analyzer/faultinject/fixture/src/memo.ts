const cache = new Map<number, number>();
export function fib(n: number): number {
  const c = cache.get(n);
  if (c !== undefined) return c;
  const r = n < 2 ? n : fib(n - 1) + fib(n - 2);
  cache.set(n, r);
  return r;
}
