// file starts with a UTF-8 BOM
export const bom = "bom-ok"
export function scenario() { return [bom, true ? "t" : /*@never*/ "f"] }
