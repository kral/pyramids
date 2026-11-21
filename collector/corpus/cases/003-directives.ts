'use client'
'use strict'
export function strictThis(this: unknown) { 'use strict'; return typeof this }
export const arrow = () => { 'use strict'; return 1 }
export function multi() { 'use strict'; 'another directive'; return arguments.length }
export function notADirective() { const x = 1; 'use strict'; return x }
export function parenNotDirective() { ('use strict'); return 2 }
class K { m() { 'use asm'; return 3 } static s() { "use strict"
  return 4 } }
const obj = { get g() { 'use strict'; return 5 }, m() { 'use strict'; return 6 } }
export function* gen() { 'use strict'; yield 7 }
export async function asy() { 'use strict'; return 8 }
export function scenario() {
  return [strictThis(), arrow(), multi(1, 2), notADirective(), parenNotDirective(), new K().m(), K.s(), obj.g, obj.m(), [...gen()]]
}
