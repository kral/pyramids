const příliš = 'žluťoučký kůň úpěl ďábelské ódy'; const e = '👨‍👩‍👧‍👦'; const r = e.length > 100 ? /*@never*/ 'ne' : 'ano'
export function úpěl(kůň: string) { return kůň.length > 3 ? kůň.toUpperCase() : /*@never*/ kůň }
export const ďábel = (ó: number) => '😀'.repeat(ó) + (ó > 1 ? '🎉' : /*@never*/ '❌')
export function počítej(ř: string[]) { let ů = 0; for (const č of ř) if (č.codePointAt(0)! > 0xffff) ů++; else ů += 0; return ů }
const 𝒳 = 'math-italic-x'
export const objekt = { 'klíč s mezerou': 1, ñandú: 2, 日本: '語', [`${'😀'}`]: 'emoji-key' }
export function scenario() {
  return { příliš, e, el: e.length, r, u: úpěl(příliš), d: ďábel(2), p: počítej(['a', '😀', '𝒳', 'č']), x: 𝒳, objekt, names: [úpěl.name, ďábel.name, počítej.name] }
}
