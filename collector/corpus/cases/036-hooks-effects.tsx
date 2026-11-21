import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
const log: string[] = [];
export function Timer({ id }: { id: string }) {
  const [n, setN] = useState(0);
  const renders = useRef(0);
  renders.current++;
  const stale = useCallback(() => n, []);
  const fresh = useCallback(() => n, [n]);
  useLayoutEffect(() => { log.push(`layout:${id}:${n}`); }, [n, id]);
  useEffect(() => {
    log.push(`effect:${id}:${n}`);
    return () => { log.push(`cleanup:${id}:${n}`); };
  }, [n, id]);
  useEffect(() => { if (n > 50) /*@never*/ log.push('never'); });
  return <button onClick={() => setN((x) => x + 1)}>{`${n}|${stale()}|${fresh()}|${renders.current}`}</button>;
}
export function scenario(t: any) {
  const r = t.render(<Timer id="a" />);
  t.fireEvent.click(r.getByRole('button'));
  t.fireEvent.click(r.getByRole('button'));
  const html = r.container.innerHTML;
  r.rerender(<Timer id="b" />);
  r.unmount();
  return { html, log };
}
