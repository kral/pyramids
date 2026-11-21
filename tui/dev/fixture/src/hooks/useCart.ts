import { useMemo, useState } from 'react';

export interface CartItem { sku: string; price: number; qty: number }

export function useCart(initial: CartItem[] = []) {
  const [items, setItems] = useState(initial);
  const totals = useMemo(() => {
    const subtotal = items.reduce((s, i) => s + i.price, 0);
    const vat = Math.round(subtotal * 0.21 * 100) / 100;
    return { subtotal, vat, total: subtotal + vat, count: items.length };
  }, [items]);
  const add = (item: CartItem) => setItems((xs) => [...xs, item]);
  return { items, totals, add };
}
