export function nums(c: boolean) {
  const big = 9007199254740993n
  const sep = 1_000_000.5
  const r: any[] = [big * 2n, sep, 0x1F, 0o17, 0b101, 1e21, .5, 5., 0.1 + 0.2, -0, 2 ** 53 + 1]
  r.push(c ? big ** 2n : /*@never*/ 0n)
  r.push((null ?? 0) || 'falsy')
  r.push(c && 0n)
  r.push(typeof (1n as any))
  r.push(5 % -3, -5 % 3, 7 >>> 1, -7 >> 1, ~5)
  return r
}
export function scenario() { return nums(true) }
