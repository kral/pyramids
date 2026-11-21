import fn from './042-export-default-function'
export default function (x: number) { return x > 1e9 ? /*@never*/ 0 : x + 1 }
export function* g() { yield 1 }
export function scenario() { return { name: fn.name, r: fn(2), len: fn.length } }
