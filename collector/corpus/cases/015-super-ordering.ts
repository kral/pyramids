const log: string[] = []
class A { constructor(public v: number) { log.push('A:' + v) } m() { return 'A.m' } }
export class B extends A {
  extra = log.push('B-field')
  constructor(flag: boolean) {
    const pre = flag ? 1 : 2
    log.push('pre:' + pre)
    if (flag) super(10)
    else /*@never*/ super(20)
    log.push('post:' + this.v)
  }
  m() { return 'B>' + super.m() }
}
export class C2 extends A {
  constructor() {
    const f = () => super(1)
    f()
    log.push('arrow-super')
  }
}
export class D extends A {
  constructor() { super((log.push('arg'), 5)); return { replaced: true } as any }
}
export class E extends A {
  constructor(x?: number) { try { super(x ?? 3) } finally { log.push('finally-after-super') } }
}
export function scenario() {
  const b = new B(true)
  new C2()
  const d = new D()
  new E()
  let err = null
  class F extends A { constructor() { if (false as boolean) super(0); /*@hit*/ log.push('no-super') } }
  try { new F() } catch (e: any) { err = e.constructor.name }
  return { log, m: b.m(), d, err }
}
