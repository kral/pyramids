// strings and comments that look like instrumentation: __vto_k[0]=1; (__vto_k[1]=1, x)
export const s1 = '__vto_k[0]=1;'
export const s2 = "(__vto_0[3]=1, expr)"
export const tpl = `__vto_x[9]=1; ${'*/'} // not a comment /* nor this */`
export const re = /\/\*[^*]*\*\/|__vto_[a-z]+\[\d+\]=1/g
export const div = 10 / 2 / /* c */ 5
export const braces = `${'}'}{${'{'}`
// __vto_k[99]=1
/* __vto_k[100]=1 */
export function scenario() {
  return { s1, s2, tpl, re: re.source, m: (s1 + s2).match(re), div, braces, slash: '//'.length, q: "it's" + 'a "q"' }
}
