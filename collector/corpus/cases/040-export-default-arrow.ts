import self from './040-export-default-arrow'
export default (x: number) => x > 100 ? /*@never*/ -1 : x * 2
export function scenario() { return { r: self(21), name: self.name, len: self.length } }
