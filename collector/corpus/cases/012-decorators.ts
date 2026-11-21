const log: string[] = []
function logged<T extends (...a: any[]) => any>(fn: T, ctx: ClassMethodDecoratorContext) {
  log.push('decorate:' + String(ctx.name) + ':' + ctx.kind + (ctx.static ? ':static' : ''))
  ctx.addInitializer(function () { log.push('init:' + String(ctx.name)) })
  return function (this: any, ...args: any[]) {
    log.push('call:' + String(ctx.name))
    return args.length > 5 ? /*@never*/ null : fn.apply(this, args)
  } as T
}
function double(_: undefined, ctx: ClassFieldDecoratorContext) {
  log.push('field:' + String(ctx.name))
  return (v: number) => v * 2
}
function tagClass<T extends new (...a: any[]) => any>(C: T, ctx: ClassDecoratorContext) {
  log.push('class:' + ctx.name)
  return class extends C { tagged = true }
}
function acc(target: ClassAccessorDecoratorTarget<any, number>, ctx: ClassAccessorDecoratorContext) {
  return { get(this: any) { return target.get.call(this) + 100 }, set(this: any, v: number) { target.set.call(this, v) } }
}
@tagClass
export class Svc {
  @double n = 21
  @acc accessor a = 1
  @logged greet(who: string) { return 'hi ' + who + this.n }
  @logged static stat() { return 's' }
}
export function scenario() {
  const s = new Svc()
  const g = s.greet('x')
  s.a = 5
  return { log, g, n: s.n, a: s.a, st: Svc.stat(), tagged: (s as any).tagged, name: Svc.name }
}
