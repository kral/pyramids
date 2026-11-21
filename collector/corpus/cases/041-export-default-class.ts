import K from './041-export-default-class'
export default class {
  static s = 'static'
  #p = 1
  m() { return this.#p + 1 }
}
export function scenario() { return { name: K.name, s: K.s, m: new K().m() } }
