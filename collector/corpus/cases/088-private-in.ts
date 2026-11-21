export class Brand {
  #b = 1
  static #count = 0
  static is(o: any) { return #b in o ? 'brand' : 'plain' }
  static check(o: any) { return o && #b in o && o.#b === 1 }
  static inc() { return ++Brand.#count }
  #pm() { return 'pm' }
  static callPm(o: any) { return #pm in o ? o.#pm() : /*@never*/ null }
}
export function scenario() {
  const b = new Brand()
  let e = null
  try { (Brand as any).is(null) } catch (x: any) { e = x.constructor.name }
  return [Brand.is(b), Brand.is({}), Brand.check(b), Brand.check(null), Brand.inc(), Brand.inc(), Brand.callPm(b), e]
}
