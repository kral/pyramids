export enum Color { Red, Green = 5, Blue }
export enum Str { A = 'a', B = 'b' + 'x'.length }
export enum Computed { X = 1 << 2, Y = X | 1, Z = 'abc'.length }
export const enum Const { One = 1, Two = One * 2 }
export enum Merged { P = 1 }
export enum Merged { Q = 2 }
enum Flags { None = 0, A = 1, B = 2, AB = A | B }
export function describe(c: Color) {
  switch (c) {
    case Color.Red: return 'red'
    case Color.Green: return 'green'
    default: return Color[c] ?? /*@never*/ 'unknown'
  }
}
export function scenario() {
  return {
    Color, Str, Computed, two: Const.Two, Merged, flags: (Flags.AB & Flags.B) ? 'hasB' : /*@never*/ 'noB',
    d: [describe(Color.Red), describe(Color.Green), describe(Color.Blue)], rev: Color[5],
  }
}
