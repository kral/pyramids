export function loops() {
  const r: any[] = []
  let x = 3
  while (x) x--
  do x++; while (x < 5)
  for (let i = 0; i < 3; i++) r.push(i)
  for (const k in { a: 1, b: 2 }) if (k === 'b') r.push(k)
  for (const v of [1, 2]) for (const w of [3]) r.push(v * w)
  let i2 = 0
  for (; i2 < 3; i2++);
  for (;;) break
  while (false) /*@never*/ r.push('never')
  for (const z of []) /*@never*/ r.push(z)
  for (var hv = 0; hv < 1; hv++) continue
  return [r, x, i2, hv]
}
export function scenario() { return loops() }
