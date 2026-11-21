export const log: string[] = []
let counter = 0
counter++
if (counter === 1) log.push('top-if')
else /*@never*/ log.push('top-else')
switch (typeof counter) { case 'number': log.push('top-switch'); break; default: /*@never*/ log.push('x') }
try { JSON.parse('{') } catch { log.push('top-catch') } finally { log.push('top-finally') }
for (const x of [1, 2]) log.push('top-for' + x)
const lazy = () => log.push('lazy')
counter > 0 && lazy()
counter < 0 && /*@never*/ lazy()
export const snapshot = [...log]
export function scenario() { return { snapshot, counter } }
