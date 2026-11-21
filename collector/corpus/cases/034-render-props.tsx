import { useState, type ReactNode } from 'react';
function Toggle({ children, initial = false }: { children: (on: boolean, flip: () => void) => ReactNode; initial?: boolean }) {
  const [on, set] = useState(initial);
  return <>{children(on, () => set((v) => !v))}</>;
}
function Mouse({ render }: { render: (p: { x: number }) => ReactNode }) { return <div>{render({ x: 3 })}</div>; }
export function App({ label }: { label?: string }) {
  return (
    <>
      <Toggle>{(on, flip) => <button onClick={flip}>{on ? 'ON' : 'OFF'}{label && `:${label}`}</button>}</Toggle>
      <Mouse render={({ x }) => x > 10 ? /*@never*/ <b>far</b> : <i>near {x}</i>} />
      <Toggle initial>{(on) => on && <em>initially</em>}</Toggle>
    </>
  );
}
export function scenario(t: any) {
  const { container, getByRole } = t.render(<App label="L" />);
  const before = container.innerHTML;
  t.fireEvent.click(getByRole('button'));
  return { before, after: container.innerHTML };
}
