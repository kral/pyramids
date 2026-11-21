export const early = hoisted(4)
function hoisted(x: number): number { return x > 1 ? hoisted(x - 1) * x : 1 }
var seenVar = typeof laterVar
var laterVar = 5
export const calledBeforeClass = (() => { try { return new (Later as any)().v } catch (e: any) { return e.name } })()
class Later { v = 1 }
export function tdz() {
  const read = () => x
  let r: any
  try { r = read() } catch (e: any) { r = e.constructor.name }
  let x = 1
  return [r, read()]
}
export function afterReturn() {
  return inner()
  function inner() { return 'inner' + typeof innerVar }
  var innerVar = 1
}
export function blockFn(c: boolean) {
  if (c) {
    function local() { return 'local' }
    return local()
  }
  return /*@never*/ 'none'
}
export function shadow() {
  var v = 'outer'
  {
    let v = 'inner'
    void v
  }
  return v
}
export function scenario() {
  return { early, seenVar, laterVar, calledBeforeClass, tdz: tdz(), ar: afterReturn(), b: blockFn(true), s: shadow() }
}
