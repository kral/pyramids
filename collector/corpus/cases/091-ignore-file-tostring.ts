/* vto-ignore-file */
// Functions whose SOURCE is observed (fn.toString(), code built from it for workers / page.evaluate /
// new Function) cannot carry hit markers. The per-file pragma above leaves the module untouched.
export function double(n: number) { return n > 0 ? n * 2 : 0 }
export const triple = (n: number) => { if (n) { return n * 3 } return 0 }
export class K { m(a = 1) { return a ?? 2 } }
export function scenario() {
  const rebuilt = new Function('return (' + double.toString() + ')(21)')()
  const viaArrow = (0, eval)('(' + triple.toString() + ')')(2)
  return {
    rebuilt, viaArrow,
    src: [double.toString(), triple.toString(), K.toString(), K.prototype.m.toString()],
    clean: ![double, triple, K].some((f) => /__vto/.test(f.toString())),
  }
}
