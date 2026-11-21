export function closures() {
  const fs: (() => number)[] = []
  for (let i = 0; i < 3; i++) fs.push(() => i)
  const vs: (() => number)[] = []
  for (var j = 0; j < 3; j++) vs.push(() => j)
  const ks: (() => string)[] = []
  for (const k in { a: 1, b: 2 }) ks.push(() => k)
  const mut: (() => number)[] = []
  for (let m = 0; m < 3; m++) { mut.push(() => m); m++ }
  const hdr: (() => number)[] = []
  for (let n = 0, f = () => n; n < 2; n++) hdr.push(f)
  return [fs.map((f) => f()), vs.map((f) => f()), ks.map((f) => f()), mut.map((f) => f()), hdr.map((f) => f())]
}
export function scenario() { return closures() }
