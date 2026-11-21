export function names(c: boolean) {
  const arrow = () => {}
  const fexp = function () {}
  const cls = class {}
  const cond = c ? () => {} : () => {}
  const paren = (() => {})
  let la: any = null
  la ??= () => {}
  let lo: any = 0
  lo ||= function () {}
  let assigned: any
  assigned = () => {}
  const obj = { m: () => {}, ['k' + 1]: function () {}, f() {}, get g() { return 1 }, 'str key': () => {}, 5: () => {}, [Symbol.for('s')]: () => {} }
  const { d = () => {} } = {} as any
  const [e = class {}] = [] as any[]
  class Holder { static sf = () => {}; inst = function () {}; #priv = () => {}; get p() { return this.#priv.name } }
  const and = c && function () {}
  const nul = null ?? (() => {})
  return [arrow.name, fexp.name, cls.name, cond.name, paren.name, la.name, lo.name, assigned.name, obj.m.name, (obj as any).k1.name, obj.f.name, (obj as any)['str key'].name, (obj as any)[5].name, (obj as any)[Symbol.for('s')].name, d.name, e.name, Holder.sf.name, new Holder().inst.name, new Holder().p, (and as any).name, nul.name]
}
export function scenario() { return names(true) }
