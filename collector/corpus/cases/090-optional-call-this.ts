const o = {
  v: 'o',
  m(this: any) { return this?.v },
  get lazy() { return { v: 'lazy', m(this: any) { return this.v } } },
  maybe: null as null | ((this: any) => string),
}
export function calls(c: boolean) {
  return [
    o.m?.(),
    o?.m?.(),
    (o?.m)?.(),
    o.maybe?.(),
    o.lazy?.m(),
    c && o?.lazy.m(),
    c ? o.m?.() : /*@never*/ 'never',
    (c ? o : null)?.m(),
    o?.['m']?.(),
  ]
}
export function scenario() { return calls(true) }
