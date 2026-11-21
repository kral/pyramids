export abstract class Shape {
  abstract readonly kind: string
  abstract area(): number
  protected abstract get sides(): number
  describe() { return `${this.kind}:${this.area()}:${this.sides}` }
  static create(k: 'sq' | 'tri'): Shape { return k === 'sq' ? new Square(2) : new Tri(3) }
}
class Square extends Shape {
  readonly kind = 'square'
  constructor(private s: number) { super() }
  area() { return this.s ** 2 }
  protected get sides() { return 4 }
}
class Tri extends Shape {
  kind = 'tri'
  constructor(readonly b: number) { super() }
  area() { return this.b > 100 ? /*@never*/ -1 : this.b * 2 }
  protected get sides() { return 3 }
}
export function scenario() {
  return [Shape.create('sq').describe(), Shape.create('tri').describe(), Object.getOwnPropertyNames(new Square(1)).sort()]
}
