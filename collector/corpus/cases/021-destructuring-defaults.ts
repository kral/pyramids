let n = 0
const tick = (v: any) => (n++, v)
export function destructure(src: any) {
  const { a = tick(1), b: { c = tick(2) } = {}, ...rest } = src
  const [x = tick('x'), , z = tick('z'), ...tail] = src.arr ?? []
  const { onClick = () => 'clicked', render = function () {} } = src
  let p, q
  ;({ p = 'P', q = p + 'Q' } = src.pq ?? {})
  let s1, s2
  ;[s1 = 'S1', s2 = s1] = src.ss ?? []
  return { a, c, rest, x, z, tail, on: onClick.name, rn: render.name, p, q, s1, s2 }
}
export function tdzDefaults() {
  try { const [p2 = q2, q2 = 1] = [] as any[]; return [p2, q2] } catch (e: any) { return e.constructor.name }
}
export function scenario() {
  const r1 = destructure({ a: 0, b: { c: null }, arr: [undefined, 1, 0, 4, 5], extra: 1 })
  const r2 = destructure({ arr: [] })
  return { r1, r2, n, tdz: tdzDefaults() }
}
