export class Rect {
  constructor(public w: number, public h: number) {}
  get area() {
    return this.w * this.h;
  }
  scale(f: number) {
    if (f <= 0) {
      throw new RangeError('factor');
    }
    return new Rect(this.w * f, this.h * f);
  }
}
export function parse(json: string): Rect | null {
  try {
    const o = JSON.parse(json);
    return new Rect(o.w, o.h);
  } catch {
    return null;
  } finally {
    calls++;
  }
}
export let calls = 0;
export function total(rects: Rect[]) {
  let sum = 0;
  let i = 0;
  while (i < rects.length) {
    sum += rects[i].area;
    i++;
  }
  return sum;
}
