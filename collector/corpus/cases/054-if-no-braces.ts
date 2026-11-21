export function chain(n: number) {
  const r: string[] = []
  if (n === 1) r.push('one'); else if (n === 2) r.push('two'); else r.push('other')
  if (n > 0) if (n > 1) r.push('gt1'); else r.push('eq1')
  if (n) ; else r.push('zero')
  if (n === 99) /*@never*/ r.push('99')
  else r.push('not99')
  if (n < 0) return r.concat('neg')
  if (n > 1e9) throw /*@never*/ new Error('never')
  if (n === 3) var hoistedInIf = 'h'
  return r.concat(String(hoistedInIf))
}
export function scenario() { return [0, 1, 2, 3, -1].map(chain) }
