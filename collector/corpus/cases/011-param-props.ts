const order: string[] = []
class Base {
  constructor(public tag: string) { order.push('base:' + tag) }
}
export class Derived extends Base {
  field = (order.push('field'), 'f')
  constructor(private a: number, public readonly b = a * 2, protected c?: string) {
    order.push('before-super')
    super(c ?? 'dflt')
    order.push('after-super:' + this.a + ':' + this.b)
  }
  get sum() { return this.a + this.b }
}
export class NoBase {
  constructor(public x = 1, public y = x + 1) {}
}
export function scenario() {
  const d = new Derived(3)
  const d2 = new Derived(1, 1, 'given')
  return { order, d: { ...d }, s: d.sum, d2: { ...d2 }, nb: { ...new NoBase() }, nb2: { ...new NoBase(5) } }
}
