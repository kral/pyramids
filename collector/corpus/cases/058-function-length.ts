export function a(x: number, y: number) {}
export function b(x: number, y = 1, z: number) {}
export function c(...rest: number[]) {}
export function d({ p }: any, [q]: any[], r = 1) {}
export const e = (x: number, y?: number) => {}
export const f = async function (x: number, y = x, ...z: number[]) {}
export function* g(x = 0) {}
export class K { constructor(public x: number, y = 2) {} m(a: any, b = a) {} }
export function scenario() { return [a, b, c, d, e, f, g, K, K.prototype.m].map((fn) => fn.length) }
