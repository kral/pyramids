function id<T>(x: T) { return x }
export function tsx(input: any) {
  const a = input!.value!
  const b = <number>input.n
  const c = input as unknown as { z: string }
  const inst = id<string>
  const d = inst('inst')
  const e = id<number>(1)!
  let f!: number
  f = 5
  const g = (input.maybe as string | undefined)?.length ?? 0
  const h = input.list![0]! satisfies number
  const i = <const T,>(x: T) => x
  return [a, b, c.z, d, e, f, g, h, i([1, 2] as const)]
}
export function withThis(this: { k: number } | void, x: number) { return (this ? (this as any).k : /*@never*/ 0) + x }
export function assertIsString(v: unknown): asserts v is string { if (typeof v !== 'string') throw new TypeError('not string') }
export function isNum(v: unknown): v is number { return typeof v === 'number' }
const instRef = id<string>
;(function () {})()
export function scenario() {
  const s: unknown = 'yes'
  assertIsString(s)
  return { t: tsx({ value: 'v', n: 2, z: 'zz', list: [7] }), w: withThis.call({ k: 1 }, 2), s, n: [isNum(1), isNum('1')], ir: instRef('r') }
}
