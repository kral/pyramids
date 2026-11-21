const log: string[] = []
const flag = await Promise.resolve(true)
export const picked = await (flag ? Promise.resolve('yes') : /*@never*/ Promise.resolve('no'))
for await (const v of [Promise.resolve(1), 2]) log.push('tla-' + v)
let caught = 'none'
try { await Promise.reject(new Error('tla-reject')) } catch (e: any) { caught = e.message }
if (flag) {
  log.push(await new Promise<string>((r) => setTimeout(() => r('timer'), 1)))
} else /*@never*/ log.push('else')
export const dyn = (await import('./lib/reexp-other')).four
export function scenario() { return { picked, log, caught, dyn } }
