export function comma() {
  let a = 1, b = 2
  const x = (a++, b++, a + b)
  const r: number[] = []
  for (let i = 0, j = 10; i < j; i += 3, j -= 3) r.push(i, j)
  const y = (r.push(99), r.length)
  const fn = (p: number) => (p++, p * 2)
  return [x, a, b, r, y, fn(1), ((a, b))]
}
export function returnComma(c: boolean) { return c ? (1, 2) : (3, /*@never*/ 4) }
export function seqInCond(o: any) { return (o.n = 1, o.n) && (o.n += 1, o) }
export function scenario() { return { c: comma(), r: returnComma(true), s: seqInCond({}) } }
