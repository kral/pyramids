import { useState } from 'react';
export function Form() {
  const [v, setV] = useState({ name: '', age: '' });
  const errs = { name: !v.name ? 'required' : v.name.length < 2 ? 'short' : null, age: v.age && isNaN(+v.age) ? 'nan' : null };
  const ok = !errs.name && !errs.age;
  return (
    <form>
      <input name="name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} aria-invalid={!!errs.name} />
      {errs.name && <small>{errs.name}</small>}
      <input name="age" value={v.age} onChange={(e) => setV((p) => ({ ...p, age: e.target.value }))} />
      {errs.age ? <small>{errs.age}</small> : null}
      <button disabled={!ok}>{ok ? 'Send' : 'Fix'}</button>
    </form>
  );
}
export function scenario(t: any) {
  const r = t.render(<Form />);
  const s = [r.container.innerHTML];
  const [n, a] = r.container.querySelectorAll('input');
  t.fireEvent.change(n, { target: { value: 'J' } }); s.push(r.container.innerHTML);
  t.fireEvent.change(n, { target: { value: 'Žofie' } }); s.push(r.container.innerHTML);
  t.fireEvent.change(a, { target: { value: 'x' } }); s.push(r.container.innerHTML);
  t.fireEvent.change(a, { target: { value: '38' } }); s.push(r.container.innerHTML);
  return s;
}
