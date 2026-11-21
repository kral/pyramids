export function Attrs({ a, b, c, n }: { a: boolean; b: boolean; c: boolean; n: number }) {
  return (
    <div
      className={a ? (b ? 'ab' : 'a') : c ? 'c' : undefined}
      data-n={n > 0 ? (n > 1 ? (n > 2 ? 'many' : 'two') : 'one') : n < 0 ? 'neg' : 'zero'}
      aria-hidden={a && b ? true : undefined}
      title={`${a ? 'A' : '-'}${b ? `B${c ? 'C' : ''}` : '-'}`}
      style={{ width: a ? 10 : b ? 20 : 30, display: n > 1000 ? /*@never*/ 'none' : 'block' }}
      tabIndex={b ? 0 : -1}
    >
      {a ? b ? c ? 'abc' : 'ab' : 'a' : 'none'}
    </div>
  );
}
export function scenario(t: any) {
  const out: string[] = [];
  for (const a of [true, false]) for (const b of [true, false]) for (const c of [true, false]) out.push(t.renderToStaticMarkup(<Attrs a={a} b={b} c={c} n={a ? 3 : b ? -1 : 0} />));
  return out;
}
