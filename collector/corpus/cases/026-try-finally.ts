const log: string[] = []
export function overrideReturn() { try { return 'try' } finally { log.push('f1') } }
export function finallyReturns(): string { try { throw new Error('x') } catch { return 'catch' } finally { return 'finally' } }
export function loopFinally() {
  const r: number[] = []
  for (let i = 0; i < 4; i++) {
    try { if (i === 1) continue; if (i === 3) break; r.push(i) } finally { r.push(-i) }
  }
  return r
}
export function nested() {
  try {
    try { throw new TypeError('inner') } finally { log.push('inner-finally') }
  } catch (e: any) {
    return e instanceof TypeError ? 'caught ' + e.message : /*@never*/ 'other'
  } finally { log.push('outer-finally') }
}
export function throwInFinally() { try { return 'ok' } finally { if (log.length > 1000) /*@never*/ throw new Error('never') } }
export function catchParam() { try { throw { code: 7 } } catch ({ code }: any) { return code } }
export async function asyncFinally() { try { await Promise.reject(new Error('rej')) } catch (e: any) { return e.message } finally { log.push('async-finally') } }
export async function scenario() {
  return { a: overrideReturn(), b: finallyReturns(), c: loopFinally(), d: nested(), e: throwInFinally(), f: catchParam(), g: await asyncFinally(), log }
}
