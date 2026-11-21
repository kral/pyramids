export function del(c: boolean) {
  const o: any = { a: 1, b: 2, c: 3, d: 4, e: 5, nested: { x: 1 } }
  const r: any[] = []
  r.push(c && delete o.a)
  r.push(c ? delete o.b : /*@never*/ delete o.c)
  r.push(delete (o.d))
  r.push(delete o?.nested?.x)
  r.push(delete o.missing?.x)
  r.push(null ?? delete o.e)
  r.push(c || /*@never*/ delete o.c)
  return { r, o }
}
export function scenario() { return [del(true)] }
