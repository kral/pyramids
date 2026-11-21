const obj: any = { notFn: 1, nested: { deep: null } }
const msg = (f: () => any) => { try { f(); return 'no-throw' } catch (e: any) { return e.constructor.name + ': ' + e.message } }
export function errors(c: boolean) {
  return [
    msg(() => obj.notFn()),
    msg(() => obj.nested.deep.x),
    msg(() => obj.missing.y),
    msg(() => c && obj.notFn()),
    msg(() => c ? obj.notFn() : /*@never*/ 0),
    msg(() => obj?.nested.deep.z),
    msg(() => (obj.nested.deep ?? obj.missing).q),
    msg(() => new obj.notFn()),
    msg(() => { const n: any = null; return n[c ? 'a' : 'b'] }),
    msg(() => { const u: any = undefined; u.call() }),
    msg(() => { 'use strict'; (Object.freeze({ a: 1 }) as any).a = 2 }),
    msg(() => [].reduce((a: any, b: any) => a + b)),
    msg(() => JSON.parse('{bad')),
    msg(() => { throw Object.assign(new RangeError('custom'), { code: 1 }) }),
  ]
}
export function scenario() { return errors(true) }
