export function F(this: any) { return new.target ? 'new' : 'call' }
export function G(this: any) { if (!new.target) return /*@never*/ 'never-called'; this.nt = new.target.name }
export class Base { kind: string; constructor() { this.kind = new.target.name } }
export class Child extends Base {}
export function viaReflect() { return Reflect.construct(Base, [], Child).kind }
export function nested(this: any) { const arrow = () => new.target; return arrow() === undefined ? 'undef' : arrow()!.name }
export function scenario() {
  return { f: [F.call(null), new (F as any)() instanceof F], g: { ...new (G as any)() }, b: new Base().kind, c: new Child().kind, r: viaReflect(), n: [(nested as any)(), new (nested as any)()] }
}
