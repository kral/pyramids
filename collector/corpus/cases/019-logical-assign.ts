const log: string[] = []
const box = { get p() { log.push('get p'); return (this as any)._p }, set p(v) { log.push('set p:' + v); (this as any)._p = v }, _p: undefined as any }
let gets = 0
const getBox = () => (gets++, box)
export function assign() {
  let a: any = null, b: any = 0, c: any = 1
  a ??= 'A'
  a ??= /*@never*/ 'never'
  b ||= 'B'
  c &&= 'C'
  let f: any
  f ??= () => 1
  let g: any = 0
  g ||= function () {}
  getBox().p ??= 'first'
  getBox().p ??= /*@never*/ 'second'
  getBox().p &&= 'third'
  const o: any = {}
  o.x ||= o.y ??= 5
  return { a, b, c, fname: f.name, gname: g.name, o, gets }
}
export function scenario() { const r = assign(); return { r, log } }
