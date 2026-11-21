export * from './lib/reexp-src'
export * as other from './lib/reexp-other'
export { default as srcDefault, two as deux } from './lib/reexp-src'
export { four } from './lib/reexp-other'
import * as self from './043-reexports'
import { mutable, bump } from './lib/reexp-src'
export type { Three as ThreeType } from './lib/reexp-src'
export function scenario() {
  const before = mutable
  bump()
  return { keys: Object.keys(self).sort(), one: self.one, deux: self.deux(), sd: self.srcDefault, o: self.other.one, f: self.four, live: [before, mutable, self.mutable], t: new self.Three().v }
}
