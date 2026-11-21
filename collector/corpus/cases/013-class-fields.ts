const order: string[] = []
const key = (k: string) => (order.push('key:' + k), k)
export class Fields {
  static count = 0
  static #secret = 'sec'
  #x = 1;
  [key('computed')] = order.push('computed-init')
  y = this.#x + 1
  arrow = () => this.y
  static { order.push('static-block'); Fields.count = Fields.#secret.length }
  static {
    if (Fields.count > 100) /*@never*/ order.push('never')
  }
  #m() { return this.#x * 10 }
  get m() { return this.#m() }
  static has(o: object) { return #x in o }
  inc() { this.#x++; return this.#x }
  static peek() { return Fields.#secret }
}
export class Sub extends Fields { z = this.y + 1; constructor() { super(); order.push('sub-ctor') } }
export function scenario() {
  const f = new Fields()
  const s = new Sub()
  const arrow = f.arrow
  return { order, count: Fields.count, y: f.y, a: arrow(), m: f.m, has: [Fields.has(f), Fields.has({}), Fields.has(s)], inc: f.inc(), z: s.z, peek: Fields.peek(), keys: Object.keys(f) }
}
