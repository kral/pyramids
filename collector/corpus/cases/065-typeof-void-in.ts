declare const undeclared: any
export function ops(c: boolean) {
  const o = { a: 1 }
  return [
    typeof undeclared,
    c && typeof undeclared,
    c ? typeof undeclared : /*@never*/ 'x',
    typeof (c ? 'str' : 1),
    void 0 ?? 'v',
    'a' in o && 'yes',
    !('b' in o) || /*@never*/ 'never',
    o instanceof Object ? 'obj' : 'no',
    (-(-1)) ** 2,
    (-2) ** 2,
    2 ** -1,
    typeof typeof c,
    !!c && !c,
  ]
}
export function scenario() { return ops(true) }
