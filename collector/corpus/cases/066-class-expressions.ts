export const Named = class Inner { who() { return Inner.name } }
export const Anon = class { static make() { return new this() } }
export const pick = (c: boolean) => c ? class A { id = 'A' } : /*@never*/ class B { id = 'B' }
export function mixin<T extends new (...a: any[]) => {}>(Base: T) { return class extends Base { mixed = true } }
class Root { r = 'root' }
export const Mixed = mixin(Root)
export class Iter { *[Symbol.iterator]() { yield 1; yield 2 } static [Symbol.hasInstance](x: any) { return x === 42 } }
export function scenario() {
  const P = pick(true)
  return { n: [Named.name, new Named().who(), Anon.name, P.name, Mixed.name], m: new Mixed(), make: Anon.make() instanceof Anon, a: new P().id, it: [...new Iter()], hi: (42 as any) instanceof Iter }
}
