import { useEffect, useLayoutEffect, useInsertionEffect } from 'react';
const log: string[] = [];
function Child({ id }: { id: string }) {
  log.push('render:' + id);
  useInsertionEffect(() => { log.push('insertion:' + id); });
  useLayoutEffect(() => { log.push('layout:' + id); return () => { log.push('layout-cleanup:' + id); }; });
  useEffect(() => { log.push('effect:' + id); return () => { log.push('effect-cleanup:' + id); }; }, []);
  return <i>{id}</i>;
}
function Parent({ show }: { show: boolean }) {
  log.push('render:parent');
  useEffect(() => { log.push('effect:parent'); });
  return <div><Child id="a" />{show ? <Child id="b" /> : null}</div>;
}
export function scenario(t: any) {
  const r = t.render(<Parent show />);
  r.rerender(<Parent show={false} />);
  r.unmount();
  return log;
}
