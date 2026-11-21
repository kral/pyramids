export function rx(s: string) {
  const r: any[] = []
  let a = 10, b = 2, g = 5
  r.push(a / b / g)
  r.push(a /b/ g)
  if (s) /x+/.test(s) && r.push('matched')
  const fn = () => /re/g
  r.push(fn().flags)
  r.push(s.replace(/[aeiou]/g, (m) => m === 'a' ? 'A' : /*@never*/ m.toUpperCase()))
  r.push([/a/, /b/].length)
  r.push(typeof /x/ === 'object' ? 'regex' : 'no')
  let i = 4
  r.push(i++ / 2)
  r.push(/[/]/.test('/'))
  r.push(`${/t/.source}`)
  return r
}
export function scenario() { return rx('xaxa') }
