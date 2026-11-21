// file uses CRLF line endings
export function crlf(x: number) {
  const tpl = `line1
line2 ${x > 0 ? 'pos' : /*@never*/ 'neg'}
line3`
  if (x > 0) {
    return tpl.split('\n').length + ':' + JSON.stringify(tpl)
  } else {
    /*@never*/ return 'neg'
  }
}
export const raw = String.raw`a
b`
export function multi(
  a: number,
  b = a
    ? 'truthy'
    : /*@never*/ 'falsy',
) {
  return a &&
    b
}
export function scenario() { return { c: crlf(1), raw: JSON.stringify(raw), m: multi(1) } }
