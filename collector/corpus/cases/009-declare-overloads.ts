declare const __injected: number | undefined
declare function ambient(x: number): string
declare global { interface Window { __vtoProbe?: number } }
declare module 'virtual-nonexistent' { export const v: number }
export function over(x: string): string
export function over(x: number): number
export function over(x: any): any {
  return typeof x === 'string' ? x.toUpperCase() : x * 2
}
export class C {
  m(a: string): string
  m(a: number): number
  m(a: any) { return a === 1 ? 'one' : a }
  declare d: number
  constructor()
  constructor(x?: number)
  constructor(public x?: number) {}
}
export function scenario() {
  const amb = typeof (globalThis as any).ambient
  return { o: [over('ab'), over(2)], m: [new C().m(1), new C().m('z')], has: 'd' in new C(), x: new C(3).x, amb, inj: typeof (globalThis as any).__injected }
}
