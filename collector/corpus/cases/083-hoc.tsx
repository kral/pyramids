import type { ComponentType } from 'react';
export function withLabel<P extends object>(C: ComponentType<P>, label: string) {
  const W = (p: P) => <div data-label={label}><C {...p} /></div>;
  W.displayName = `withLabel(${C.displayName || C.name || /*@never*/ 'Anon'})`;
  return W;
}
function Base({ x }: { x: number }) { return <b>{x}</b>; }
export const Wrapped = withLabel(Base, 'L');
export const Twice = withLabel(withLabel(Base, 'in'), 'out');
const pick = (c: boolean) => (c ? function Yes() { return <i>yes</i>; } : function No() { return <i>no</i>; });
export function scenario(t: any) {
  const P = pick(true);
  return { h: t.renderToStaticMarkup(<><Wrapped x={1} /><Twice x={2} /><P /></>), names: [Wrapped.displayName, Twice.displayName, P.name] };
}
