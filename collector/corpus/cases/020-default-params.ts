let evals = 0
const ev = (v: any) => (evals++, v)
export function f(a: number, b = a * 2, c = () => a + b, d = ev('d')) { return [a, b, c(), d] }
export function g(x: any, cb = () => 'cb') { return [x, cb.name, cb()] }
export function h(a = 1, b: number, ...rest: number[]) { return [a, b, rest] }
export const arrowDefault = (x: number, y = x > 10 ? /*@never*/ 'big' : 'small') => [x, y]
export function scoping(x = 1, y = () => x) { var x = 2 as number; return [x, y()] }
export function argsLen(a: any, b = 2) { return [arguments.length, a, b] }
export class M { m(a = this.base, b = a + 1) { return [a, b] } base = 10 }
export function destr({ a = 1, b = a } = {} as any, [c = 3] = []) { return [a, b, c] }
export function scenario() {
  return {
    f1: f(1), f2: f(1, 5, undefined, 'given'), evals,
    g: g(0), h: h(undefined, 2, 3, 4), ad: arrowDefault(1), sc: scoping(), al: [argsLen(1), argsLen(1, undefined)],
    lens: [f.length, g.length, h.length, arrowDefault.length, destr.length], m: new M().m(), d: [destr(), destr({ a: 5 }, [9])],
  }
}
