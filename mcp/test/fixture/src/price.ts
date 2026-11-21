export function price(base: number, qty: number, vip = false): number {
  if (qty <= 0) throw new Error('qty');
  let total = base * qty;
  if (qty >= 10) total *= 0.9;
  if (vip) total *= 0.8;
  return Math.round(total * 100) / 100;
}
