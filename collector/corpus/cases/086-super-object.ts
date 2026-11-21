const base = { greet() { return 'base' }, get g() { return 'gbase' } }
export const child = {
  __proto__: base,
  greet() { return 'child>' + super.greet() },
  get g() { return 'gchild>' + super.g },
  arrow() { const f = () => super.greet(); return f() },
  maybe(c: boolean) { return c ? super.greet() : /*@never*/ 'none' },
}
export function scenario() { return [child.greet(), child.g, child.arrow(), child.maybe(true)] }
