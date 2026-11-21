/** Formátuje cenu v Kč: 1234.5 → "1 234,50 Kč" */
export function formatPrice(value: number): string {
  const fixed = value.toFixed(2);
  return `${fixed} Kč`;
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' });
}
