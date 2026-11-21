export const idf = (x: any) => x
export const seq = (x: number) => (x++, x)
export const awaiter = async (p: Promise<number>) => await p
export const voider = () => void 'ignored'
export const curry = (a: number) => (b: number) => (c: number) => a + b + c
export const condArrows = (c: boolean) => c ? () => 'A' : /*@never*/ () => 'B'
export const fnExpr = () => function named() { return 'named' }
export const inDefault = (f = (y: number) => y * 3) => f(2)
export const yieldLike = () => typeof (globalThis as any).yield
export const nullish = (o?: { v?: number }) => o?.v ?? -1
export const throwing = (): never => { throw new Error('thrown-in-arrow') }
export async function scenario() {
  let te = null
  try { throwing() } catch (e: any) { te = e.message }
  return [idf(1), seq(1), await awaiter(Promise.resolve(5)), voider(), curry(1)(2)(3), condArrows(true)(), fnExpr()(), fnExpr().name, inDefault(), yieldLike(), nullish(), nullish({ v: 0 }), te]
}
