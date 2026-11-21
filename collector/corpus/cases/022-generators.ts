const log: string[] = []
export function* gen(c: boolean): Generator<any, string, any> {
  try {
    const got = yield c ? 'yes' : /*@never*/ 'no'
    log.push('got:' + got)
    const r = c ? yield 1 : /*@never*/ yield 2
    log.push('r:' + r)
    yield* [10, 11]
    yield* sub()
    return 'done'
  } finally {
    log.push('finally')
  }
}
function* sub() { const x = yield 'sub'; return x }
export function* infinite() { let i = 0; for (;;) { if (i > 1000) /*@never*/ return; yield i++ } }
export const objGen = { *m() { yield* 'ab' }, async *am() { yield 1 } }
export function scenario() {
  const it = gen(true)
  const steps = [it.next(), it.next('A'), it.next('B'), it.next(), it.next(), it.next(), it.next('S'), it.next()]
  const inf = infinite()
  const first = [inf.next().value, inf.next().value]
  const ret = inf.return(99 as never)
  const g2 = gen(true); g2.next(); const early = g2.return('early')
  let thrown: any
  const g3 = gen(true); g3.next(); try { g3.throw(new Error('boom')) } catch (e: any) { thrown = e.message }
  return { steps, first, ret, early, thrown, log, ab: [...objGen.m()] }
}
