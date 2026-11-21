export const columns = [
  { key: 'name', label: 'Name', render: (r: any) => String(r.name) },
  { key: 'qty', label: 'Qty', render: (r: any) => String(r.qty) },
];
export function cell(i: number, row: any): string {
  return columns[i].render(row);
}
