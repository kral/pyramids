import { useMemo, useState, useId, useSyncExternalStore, StrictMode } from 'react';
let listeners = new Set<() => void>(), value = 0;
const store = { sub(l: () => void) { listeners.add(l); return () => listeners.delete(l); }, get: () => value, set(v: number) { value = v; listeners.forEach((l) => l()); } };
const calls: string[] = [];
export function useToggle(initial: boolean | (() => boolean) = false) {
  const [on, set] = useState(initial);
  return [on, () => set((x) => !x)] as const;
}
export function useDerived(n: number) {
  return useMemo(() => { calls.push('memo:' + n); return n < 0 ? /*@never*/ 'neg' : n % 2 ? 'odd' : 'even'; }, [n]);
}
function useStore() { return useSyncExternalStore(store.sub, store.get, store.get); }
function Comp() {
  const [on, flip] = useToggle(() => { calls.push('lazy-init'); return true; });
  const id = useId();
  const v = useStore();
  const d = useDerived(v);
  if (!on) return <p id={id}>off {d}</p>;
  return <button id={id} onClick={flip}>on {v} {d}</button>;
}
export function scenario(t: any) {
  const r = t.render(<StrictMode><Comp /></StrictMode>);
  const a = r.container.innerHTML;
  t.act(() => store.set(3));
  const b = r.container.innerHTML;
  t.fireEvent.click(r.getByRole('button'));
  return { a, b, c: r.container.innerHTML, calls };
}
