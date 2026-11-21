import { useState, useTransition, useDeferredValue, startTransition } from 'react';
export function Search() {
  const [q, setQ] = useState('');
  const [pending, start] = useTransition();
  const deferred = useDeferredValue(q);
  const [res, setRes] = useState<string[]>([]);
  return (
    <div>
      <input value={q} onChange={(e) => { setQ(e.target.value); start(() => setRes(e.target.value ? ['r:' + e.target.value] : [])); }} />
      <p>{pending ? 'pending' : 'idle'}</p>
      <ul>{res.map((r) => <li key={r}>{r}</li>)}</ul>
      <i>{deferred}</i>
    </div>
  );
}
export async function scenario(t: any) {
  const r = t.render(<Search />);
  await t.act(async () => { t.fireEvent.change(r.container.querySelector('input'), { target: { value: 'abc' } }); });
  await t.act(async () => { startTransition(() => {}); });
  return r.container.innerHTML.replace(/ pending/g, '');
}
