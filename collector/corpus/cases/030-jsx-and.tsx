const X = ({ n }: { n: number }) => <i>x{n}</i>;
export function And({ a, list, s, z }: { a: boolean; list: number[]; s: string; z?: string | null }) {
  return (
    <div>
      {a && <X n={1} />}
      {!a && /*@never*/ <X n={2} />}
      {list.length && <X n={3} />}
      {0 && /*@never*/ <X n={4} />}
      {s && <b>{s}</b>}
      {z || <em>fallback</em>}
      {z ?? <u>nullish</u>}
      {a && list.length > 0 && <span>{list.map((v) => v > 1 && <X key={v} n={v} />)}</span>}
    </div>
  );
}
export function scenario(t: any) {
  return [
    t.renderToStaticMarkup(<And a list={[1, 2]} s="" z={null} />),
    t.renderToStaticMarkup(<And a list={[]} s="str" z="" />),
    t.renderToStaticMarkup(<And a list={[5]} s="q" z="zz" />),
  ];
}
