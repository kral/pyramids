export class Acc {
  accessor plain = 1
  static accessor st = 'st'
  accessor #priv = 'p'
  accessor ['comp' + 'uted'] = 'c'
  get priv() { return this.#priv }
  set priv(v) { this.#priv = v ?? /*@never*/ 'never' }
}
export function scenario() {
  const a = new Acc()
  a.plain++
  a.priv = 'q'
  const d = Object.getOwnPropertyDescriptor(Acc.prototype, 'plain')!
  return { plain: a.plain, st: Acc.st, priv: a.priv, comp: (a as any).computed, own: Object.keys(a), accessorDesc: [typeof d.get, typeof d.set] }
}
