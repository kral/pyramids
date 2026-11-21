let calls = 0
const side = () => (calls++, 'k')
export function chains(a: any) {
  const r: any[] = []
  r.push(a?.b.c)
  r.push(a?.[side()]?.())
  r.push(a?.b!.c)
  r.push(a?.fn?.(side()))
  r.push(a?.b?.c ?? 'dflt')
  try { r.push((a?.b).c) } catch (e: any) { r.push(e.constructor.name) }
  r.push(a?.arr?.[0]?.[1])
  r.push(typeof a?.b)
  r.push(a?.b?.c?.d?.e)
  r.push(a?.['b']?.['c'])
  return r
}
export function scenario() {
  const full = { b: { c: 1 }, k: () => 'called-k', fn: (x: any) => 'fn:' + x, arr: [[0, 'one']] }
  const out = [chains(full), chains(null), chains(undefined), chains({ b: {} })]
  return { out, calls }
}
