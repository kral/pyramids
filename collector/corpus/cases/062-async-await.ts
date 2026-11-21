const log: string[] = []
const delay = (v: string, ms = 0) => new Promise<string>((r) => setTimeout(() => r(v), ms))
export async function ordering() {
  const p = Promise.resolve().then(() => log.push('micro1'))
  queueMicrotask(() => log.push('micro2'))
  log.push('sync')
  const a = await (log.length > 100 ? /*@never*/ delay('never') : delay('a'))
  log.push('after-' + a)
  await p
  const all = await Promise.all([delay('x', 2), delay('y', 1), 'z'])
  const thenable = await { then(r: (v: string) => void) { log.push('thenable'); r('T') } }
  return { all, thenable }
}
export class Svc { load = async (x: number) => x > 0 ? await delay('pos' + x) : 'nonpos'; async *[Symbol.asyncIterator]() { yield 1 } }
export async function microOrder() {
  const out: string[] = []
  const f = async (n: string, c: boolean) => { out.push(n + '1'); c ? await null : /*@never*/ 0; out.push(n + '2') }
  const ps = [f('a', true), f('b', true)]
  out.push('main')
  await Promise.all(ps)
  return out
}
export async function scenario() {
  const r = await ordering()
  const s = new Svc()
  return { r, log, l: [await s.load(1), await s.load(0)], m: await microOrder() }
}
