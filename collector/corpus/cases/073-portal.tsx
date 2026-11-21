import { createPortal } from 'react-dom';
import { useState } from 'react';
export function Modal({ open }: { open: boolean }) {
  const [n, set] = useState(0);
  return (
    <div id="host">
      {open && createPortal(<dialog open onClick={() => set(n + 1)}>modal {n}</dialog>, document.body)}
      {!open && /*@never*/ <p>closed</p>}
    </div>
  );
}
export function scenario(t: any) {
  const r = t.render(<Modal open />);
  t.fireEvent.click(document.querySelector('dialog')!);
  const out = { host: r.container.innerHTML, dialog: document.querySelector('dialog')!.outerHTML };
  r.unmount();
  return { ...out, after: document.querySelectorAll('dialog').length };
}
