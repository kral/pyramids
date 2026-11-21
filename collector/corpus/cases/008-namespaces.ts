export namespace Geo {
  export const PI2 = Math.PI * 2
  export function area(r: number) { return r > 0 ? PI2 / 2 * r * r : /*@never*/ 0 }
  export namespace Inner { export const deep = 'deep' }
  const hidden = 'hidden'
  export const peek = () => hidden
}
export namespace A.B.C { export const abc = 'abc' }
export function Merge() { return 'fn' }
export namespace Merge { export const extra = 'extra' }
export class Klass { static make() { return new Klass() } }
export namespace Klass { export const tag = 'k' }
namespace Empty {}
export namespace TypesOnly { export type T = number; export interface I { x: T } }
export function scenario() {
  return { a: Geo.area(1).toFixed(5), d: Geo.Inner.deep, p: Geo.peek(), abc: A.B.C.abc, m: [Merge(), Merge.extra], k: [Klass.tag, Klass.make() instanceof Klass] }
}
