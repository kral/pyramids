const A = () => <a>A</a>;
const B = () => <b>B</b>;
export function T({ c, d, n }: { c: boolean; d: boolean; n: number }) {
  return (
    <section className={c ? 'on' : 'off'} style={d ? { color: 'red' } : undefined}>
      {c ? <A /> : <B />}
      {c ? d ? <A /> : <B /> : n > 999 ? /*@never*/ <i>huge</i> : <B />}
      {n === 0 ? null : n === 1 ? 'one' : `many:${n}`}
      <p title={c ? (d ? 'cd' : 'c') : d ? 'd' : 'none'}>{d ? <>frag</> : 'txt'}</p>
    </section>
  );
}
export function scenario(t: any) {
  return [
    t.renderToStaticMarkup(<T c d n={0} />),
    t.renderToStaticMarkup(<T c={false} d n={1} />),
    t.renderToStaticMarkup(<T c d={false} n={5} />),
    t.renderToStaticMarkup(<T c={false} d={false} n={2} />),
  ];
}
