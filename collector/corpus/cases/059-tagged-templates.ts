const seen: TemplateStringsArray[] = []
function tag(s: TemplateStringsArray, ...v: any[]) { seen.push(s); return s.raw.join('#') + '|' + v.join(',') }
const obj = { pre: 'obj', tag(this: any, s: TemplateStringsArray, ...v: any[]) { return this.pre + ':' + s.join('_') + v.join() } }
const curriedTag = (s: TemplateStringsArray) => (s2: TemplateStringsArray) => s[0] + '+' + s2[0]
export function run(c: boolean) {
  const r: any[] = []
  for (let i = 0; i < 2; i++) r.push(tag`a${i}b${c ? 'c' : /*@never*/ 'd'}\n`)
  r.push(obj.tag`x${1}y`)
  r.push((c ? obj : obj).tag`z`)
  r.push(curriedTag`first``second`)
  r.push(String.raw`\u{1F600}${c ? `in${`ner`}` : 'x'}`)
  r.push(`nested ${`level ${c ? `deep ${1 + 1}` : ''}`}`)
  r.push(tag`\unicode-invalid-escape`)
  return r
}
export function scenario() {
  const r1 = run(true), r2 = run(true)
  return { r1, r2, sameSite: seen[0] === seen[1], sameAcrossCalls: seen[0] === seen[seen.length > 6 ? 5 : 0], frozen: Object.isFrozen(seen[0]), n: seen.length }
}
