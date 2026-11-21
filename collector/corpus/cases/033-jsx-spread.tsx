const Show = (p: any) => <span {...p}>{Object.keys(p).sort().join(',')}</span>;
export function Spread({ c, rest }: { c: boolean; rest: Record<string, any> }) {
  const a = { id: 'a', title: 'A' };
  const b = { id: 'b' };
  return (
    <div>
      <Show {...a} id="override" />
      <Show id="first" {...a} />
      <Show {...(c ? a : /*@never*/ b)} />
      <Show {...(c && { 'data-c': 1 })} />
      <Show {...rest} {...{ 'aria-label': 'L' }} />
      <Show {...(null as any)} x={c ? 1 : 2} />
    </div>
  );
}
export function KeySpread() {
  const p: any = { key: 'k1', 'data-x': 'y' };
  return <ul>{[1].map(() => <li {...p} />)}</ul>;
}
export function scenario(t: any) {
  return [t.renderToStaticMarkup(<Spread c rest={{ role: 'note', hidden: false }} />), t.renderToStaticMarkup(<KeySpread />)];
}
