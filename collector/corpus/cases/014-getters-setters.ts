const log: string[] = []
export const obj = {
  _v: 1,
  get v() { log.push('get'); return this._v },
  set v(x: number) { log.push('set:' + x); this._v = x < 0 ? /*@never*/ 0 : x },
  get ['comp' + 'uted']() { return 'c' },
}
class Base { get name() { return 'base' } set name(_v: string) { log.push('base-set') } }
export class Acc extends Base {
  #t = 0
  get name() { return 'acc>' + super.name }
  set name(v: string) { super.name = v; log.push('acc-set:' + v) }
  static get s() { return 'static-get' }
  get t() { return this.#t }
  set t(v) { this.#t = v ?? /*@never*/ 0 }
}
export function scenario() {
  obj.v = 3
  const r1 = obj.v
  obj.v++
  const a = new Acc()
  a.name = 'n'
  a.t = 7
  const d = Object.getOwnPropertyDescriptor(obj, 'v')!
  return { log, r1, v: obj._v, c: (obj as any).computed, n: a.name, s: Acc.s, t: a.t, dget: typeof d.get, dname: d.get!.name, sname: d.set!.name }
}
