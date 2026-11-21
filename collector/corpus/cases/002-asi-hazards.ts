const log: string[] = []
const a = 1
;[1, 2].forEach(x => log.push('n' + x))
const f = () => 'f'
;(function () { log.push('iife') })()
const s = `t`
;`${s}u`.split('').forEach(c => log.push(c))
let i = 0
i
++i
let q = 8
/2/2
const g = a
+a
export function asiReturn(x: number) {
  if (x > 0) return
  x
  return x * 2
}
export function noSemi(c: boolean) {
  let r = 'start'
  if (c) r = 'yes'
  else /*@never*/ r = 'no'
  const g2 = r
  ;[r] = [g2 + '!']
  return r
}
export function throwsAfterNewline(x: number) {
  const h = (v: number) => v
  let out = h
  (x)
  return out
}
export function postfix() {
  let k = 1, m = 2
  k
  ++
  m
  return [k, m]
}
export function scenario() {
  return { log, i, q, g, a: asiReturn(1), b: asiReturn(-1), c: noSemi(true), t: throwsAfterNewline(3), p: postfix(), f: f() }
}
