export function labeled() {
  const r: string[] = []
  outer: for (let i = 0; i < 3; i++) {
    inner: for (let j = 0; j < 3; j++) {
      if (j === 1) continue outer
      if (i === 2) break outer
      r.push(`${i}${j}`)
      if (j > 5) /*@never*/ continue inner
    }
  }
  blk: {
    r.push('in-block')
    if (r.length) break blk
    /*@never*/ r.push('unreachable')
  }
  a: b: for (const x of [1, 2]) { if (x === 1) continue a; r.push('x' + x); break b }
  w: while (true) { do { break w } while (false) }
  lbl: if (r) { r.push('labeled-if'); break lbl }
  sw: switch (1) { case 1: for (;;) break sw }
  single: r.push('labeled-expr')
  return r
}
export function scenario() { return labeled() }
