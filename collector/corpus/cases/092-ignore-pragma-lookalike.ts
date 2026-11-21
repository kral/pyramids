// Not a pragma: the words appear in a string and in an identifier only → instrumented as usual.
export const note = 'put vto-ignore-file into a comment to opt out'
const vtoIgnoreFile = (x: number) => (x > 1 ? /*@hit*/ 'big' : /*@never*/ 'small')
export function scenario() { return { note, r: vtoIgnoreFile(2) } }
