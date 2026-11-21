type Cfg = { mode: 'a' | 'b'; n?: number }
export const cfg = { mode: 'a', n: 1 } satisfies Cfg
export const tuple = [1, 'two', { three: 3 }] as const
export const nested = { list: [1, 2] as const, m: ('b' as const) } satisfies Record<string, unknown>
export function pick(c: boolean) {
  return (c ? cfg : ({ mode: 'b' } satisfies Cfg)) as Cfg
}
export function chain(x: unknown) {
  return ((x as number) satisfies number) + (x as any as number)
}
const fnSat = ((n: number) => n * 2) satisfies (n: number) => number
export function scenario() {
  return { cfg, tuple, nested, p1: pick(true), p2: pick(false), c: chain(2), f: fnSat(4), name: fnSat.name }
}
