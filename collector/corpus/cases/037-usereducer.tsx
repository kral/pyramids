import { useReducer } from 'react';
type S = { count: number; hist: string[] };
type A = { type: 'inc'; by?: number } | { type: 'dec' } | { type: 'reset'; to: number } | { type: 'bogus' };
export function reducer(s: S, a: A): S {
  switch (a.type) {
    case 'inc': return { count: s.count + (a.by ?? 1), hist: [...s.hist, 'inc'] };
    case 'dec': return { ...s, count: s.count - 1, hist: s.hist.concat('dec') };
    case 'reset': return init(a.to);
    default: return s;
  }
}
function init(n: number): S { return { count: n, hist: n > 1e6 ? /*@never*/ ['huge'] : [] }; }
export function Ctr() {
  const [s, dispatch] = useReducer(reducer, 5, init);
  return (
    <div>
      <output>{s.count}:{s.hist.join(',')}</output>
      <button onClick={() => dispatch({ type: 'inc' })}>inc</button>
      <button onClick={() => dispatch({ type: 'inc', by: 10 })}>inc10</button>
      <button onClick={() => dispatch({ type: 'dec' })}>dec</button>
      <button onClick={() => dispatch({ type: 'reset', to: 1 })}>reset</button>
      <button onClick={() => dispatch({ type: 'bogus' })}>bogus</button>
    </div>
  );
}
export function scenario(t: any) {
  const r = t.render(<Ctr />);
  const seq = ['inc', 'inc10', 'dec', 'bogus', 'reset', 'inc'];
  const snaps = seq.map((name) => { t.fireEvent.click(r.getByText(name)); return r.container.querySelector('output').textContent; });
  return snaps;
}
