// Modules loaded lazily (await import, import inside a callback, import().then) – semantics must not
// change; the collector records them as modules of the test file (collector/test covers the records).
export async function lazy() { const m = await import('./lib/lazy-target'); return m.value(2) }
export const viaThen = () => import('./lib/lazy-target').then((m) => m.value(3))
export async function scenario() {
  const cond = Math.max(1, 2) > 1
  const a = await lazy()
  const b = await viaThen()
  const c = cond ? (await import('./lib/lazy-target')).value(4) : /*@never*/ -1
  return { a, b, c, same: (await import('./lib/lazy-target')) === (await import('./lib/lazy-target')) }
}
