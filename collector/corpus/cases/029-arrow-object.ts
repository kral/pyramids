export const mk = () => ({ a: 1 })
export const mkConst = () => ({ k: 'v' }) as const
export const spread = (x: any) => ({ ...x, y: x.y ?? 0 })
export const curried = (a: number) => (b: number) => ({ a, b })
export const cond = (c: boolean) => c ? ({ yes: 1 }) : /*@never*/ ({ no: 1 })
export const asyncObj = async () => ({ async: true })
export const assignInArrow = (o: any) => ({ p: o.p } = { p: 'assigned' })
export const labelLike = () => { a: 1 }
export const emptyObj = () => ({})
export const seq = () => (0, { s: 1 })
export const nestedArrowBody = () => () => () => ({ deep: true })
export async function scenario() {
  const o: any = {}
  return { mk: mk(), c: mkConst(), s: spread({ x: 1 }), cu: curried(1)(2), co: cond(true), as: await asyncObj(), ai: [assignInArrow(o), o], l: (labelLike as any)(), e: emptyObj(), seq: seq(), n: nestedArrowBody()()() }
}
