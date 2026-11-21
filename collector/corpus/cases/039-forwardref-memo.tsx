import { forwardRef, memo, useImperativeHandle, useRef, useState, type Ref } from 'react';
let renders: string[] = [];
export const Input = forwardRef<HTMLInputElement, { label: string }>(function Input({ label }, ref) {
  renders.push('Input');
  return <label>{label}<input ref={ref} defaultValue={label} /></label>;
});
export const Pure = memo(function Pure({ v }: { v: number; noise?: number }) { renders.push('Pure:' + v); return <i>{v}</i>; }, (a, b) => a.v === b.v);
export const MemoArrow = memo(({ s }: { s: string }) => { renders.push('MemoArrow'); return <b>{s}</b>; });
const Handle = forwardRef((_: {}, ref: Ref<{ ping(): string }>) => { useImperativeHandle(ref, () => ({ ping: () => 'pong' })); return null; });
Handle.displayName = 'HandleDN';
function Ref19({ ref, x }: { ref?: Ref<HTMLSpanElement>; x: number }) { return <span ref={ref}>{x}</span>; }
export function App() {
  const r = useRef<HTMLInputElement>(null), h = useRef<any>(null), s = useRef<HTMLSpanElement>(null);
  const [n, set] = useState(0);
  return (
    <div>
      <Input ref={r} label="L" />
      <Pure v={1} noise={n} />
      <MemoArrow s="m" />
      <Handle ref={h} />
      <Ref19 ref={s} x={n} />
      <button onClick={() => set(n + 1)}>{r.current ? r.current.value + (h.current?.ping() ?? '') + s.current?.tagName : 'init'}</button>
    </div>
  );
}
export function scenario(t: any) {
  const r = t.render(<App />);
  t.fireEvent.click(r.getByRole('button'));
  return { html: r.container.innerHTML, renders, names: [Input.displayName, (Input as any).render.name, (Pure as any).type.name, (MemoArrow as any).type.name, Handle.displayName] };
}
