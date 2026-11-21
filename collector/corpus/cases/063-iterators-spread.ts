const log: string[] = []
const iter = (n: number) => ({ [Symbol.iterator]() { let i = 0; return { next: () => ({ done: i >= n, value: i++ }), return() { log.push('ret'); return { done: true, value: undefined } } } } })
export function spread(c: boolean) {
  const a = [...(c ? [1, 2] : /*@never*/ [3])]
  const b = [...iter(3), ...(c && iter(1))]
  const [first] = iter(5)
  const { length, ...restObj } = { length: 1, x: 2, ...(c ? { y: 3 } : {}), ...(null as any), ...'ab' }
  const m = Math.max(...[1, 5, 3], ...(c ? [9] : []))
  const s = new Set([...'hello'])
  return { a, b, first, length, restObj, m, s }
}
export function scenario() { return { r: spread(true), log } }
