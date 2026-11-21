import { renderHook, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useCart } from './useCart';

describe('useCart', () => {
  it('computes totals with quantity', () => {
    const { result } = renderHook(() => useCart([{ sku: 'A', price: 100, qty: 2 }]));
    expect(result.current.totals).toEqual({ subtotal: 200, vat: 42, total: 242, count: 2 });
  });

  it('adds item', () => {
    const { result } = renderHook(() => useCart());
    act(() => result.current.add({ sku: 'B', price: 50, qty: 1 }));
    expect(result.current.items).toHaveLength(1);
  });
});
