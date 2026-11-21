const obj = {
  name: 'obj',
  m(this: any) { return this?.name ?? 'unbound' },
  tag(this: any, s: TemplateStringsArray, ...v: any[]) { return (this?.name ?? 'unbound') + ':' + s.raw.join('|') + v.join(',') },
  inner: { name: 'inner', m(this: any) { return this?.name ?? 'unbound' } },
}
const other = { name: 'other', m(this: any) { return this?.name ?? 'unbound' } }
export function cases(a: any, c: boolean) {
  const r: any[] = []
  r.push(a && obj.m())
  r.push((a ?? obj).m())
  r.push((null ?? obj).m())
  r.push((a || obj).m())
  r.push((c ? obj : other).m())
  r.push((obj).m())
  r.push((0, obj.m)())
  r.push((c ? obj.m : other.m)())
  r.push(obj.m?.())
  r.push(obj?.m())
  r.push(obj.inner?.m())
  r.push((c && obj.inner).m())
  r.push(obj.tag`a${1}b`)
  r.push((c ? obj : other).m.call(other))
  r.push(c ? obj.m() : /*@never*/ other.m())
  r.push(obj[c ? 'm' : 'name' as 'm']())
  r.push(((obj)).inner.m())
  r.push(a?.x ?? obj.m())
  return r
}
export function scenario() {
  return [cases(obj, true), cases(null, true), cases(other, true)]
}
