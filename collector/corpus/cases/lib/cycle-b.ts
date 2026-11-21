import { hoistedA, constA } from '../053-cycle'
export const fromB = hoistedA('called-from-b-during-eval')
export function readConst() { return constA }
