import { fromB, readConst } from './lib/cycle-b'
export function hoistedA(x: string) { return x.length > 100 ? /*@never*/ 'long' : 'A(' + x + ')' }
export const constA = 'constA'
export function scenario() { return { fromB, c: readConst() } }
