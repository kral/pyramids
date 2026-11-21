const log: string[] = []
export async function* agen(n: number) {
  try {
    for (let i = 0; i < n; i++) {
      await null
      if (i === 100) /*@never*/ throw new Error('never')
      yield i % 2 ? `odd${i}` : `even${i}`
    }
  } finally { log.push('agen-finally') }
}
const iterable = {
  [Symbol.asyncIterator]() {
    let i = 0
    return { next: async () => ({ done: i >= 3, value: i++ }), return: async () => (log.push('return-called'), { done: true, value: undefined }) }
  },
}
export async function consume() {
  const out: any[] = []
  for await (const v of agen(4)) out.push(v)
  for await (const v of [Promise.resolve('p1'), 'plain', Promise.resolve('p2')]) out.push(v)
  for await (const v of iterable) { if (v === 1) break; out.push('it' + v) }
  for await (const v of agen(10)) { if (v === 'odd1') break; out.push(v) }
  return out
}
export async function scenario() { return { out: await consume(), log } }
