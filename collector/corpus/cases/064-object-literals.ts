const order: string[] = []
const k = (s: string) => (order.push(s), s)
const proto = { hello() { return 'from-proto' } }
export function objects(c: boolean) {
  const __proto__ = { shorthand: true }
  const o1: any = { __proto__: c ? proto : /*@never*/ null }
  const o2: any = { '__proto__': proto }
  const o3: any = { __proto__ }
  const o4: any = { ['__proto__']: proto }
  const o5: any = { [k('a')]: k('va'), [k('b')]: k('vb'), a: 'dup-overrides', ...{ s: 1 } }
  const o6: any = { __proto__: proto, greet() { return 'sub>' + super.hello() } }
  return { p1: Object.getPrototypeOf(o1) === proto, p2: Object.getPrototypeOf(o2) === proto, own3: Object.keys(o3), p4: Object.getPrototypeOf(o4) === Object.prototype, own4: Object.keys(o4), o5, order, g: o6.greet() }
}
export function scenario() { return objects(true) }
