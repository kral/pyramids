export function List({ items }: { items: string[] }) {
  return <ul>{items.map((i) => <li>{i}</li>)}</ul>;
}
export const ArrowList = ({ items }: { items: string[] }) => <ol>{items.map((i, idx) => idx > 50 ? /*@never*/ null : <li key={i}>{i}</li>)}</ol>;
export function scenario(t: any) {
  const r = t.render(<div><List items={['a', 'b']} /><ArrowList items={['c', 'd']} /></div>);
  return r.container.innerHTML;
}
