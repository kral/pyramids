export function sw(x: any) {
  const r: string[] = []
  switch (x) {
    case 1:
      r.push('one')
    case 2:
      r.push('two')
      break
    default:
      r.push('default')
    case 3:
    case 4: {
      let scoped = 'three-four'
      r.push(scoped)
      break
    }
    case 'never':
      /*@never*/ r.push('never-case')
      break
    case 5:
  }
  return r
}
export function sw2(x: number) {
  switch (true) {
    case x < 0: return 'neg'
    case x === 0: return 'zero'
    case x > 1e9: /*@never*/ return 'huge'
  }
  return 'pos'
}
export function lexical(k: number) {
  switch (k) {
    case 0:
      let v = 'zero'
      return v
    case 1:
      v = 'one'
      return v
  }
}
export function nested(a: number, b: number) {
  out: switch (a) {
    case 1:
      switch (b) { case 1: break out; case 2: return 'b2' }
      return 'a1'
    default: return 'da'
  }
  return 'broke-out'
}
export function scenario() {
  let tdz = null
  try { lexical(1) } catch (e: any) { tdz = e.constructor.name }
  return { a: [1, 2, 3, 4, 5, 9].map(sw), b: [-1, 0, 3].map(sw2), l: lexical(0), tdz, n: [nested(1, 1), nested(1, 2), nested(1, 3), nested(2, 0)] }
}
