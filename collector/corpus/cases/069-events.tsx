import { useState, type KeyboardEvent } from 'react';
export function Ev() {
  const [log, setLog] = useState<string[]>([]);
  const add = (s: string) => setLog((l) => [...l, s]);
  const onKey = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'Enter': add('enter'); break;
      case 'Escape': add('esc');
      case 'Tab': add('tab-or-fallthrough'); break;
      default: add('key:' + e.key);
    }
  };
  return (
    <div onClick={() => add('outer')}>
      <form onSubmit={(e) => { e.preventDefault(); add('submit'); }}>
        <input onKeyDown={onKey} onChange={(e) => add('change:' + e.target.value)} />
        <button type="submit" onClick={(e) => { e.altKey ? /*@never*/ add('alt') : add('btn'); }}>go</button>
      </form>
      <span onClick={(e) => { e.stopPropagation(); add('span-stopped'); }}>s</span>
      <ol>{log.map((l, i) => <li key={i}>{l}</li>)}</ol>
    </div>
  );
}
export function scenario(t: any) {
  const r = t.render(<Ev />);
  const input = r.container.querySelector('input');
  t.fireEvent.keyDown(input, { key: 'Enter' });
  t.fireEvent.keyDown(input, { key: 'Escape' });
  t.fireEvent.keyDown(input, { key: 'a' });
  t.fireEvent.change(input, { target: { value: 'hey' } });
  t.fireEvent.click(r.getByText('go'));
  t.fireEvent.click(r.getByText('s'));
  return r.container.querySelector('ol').innerHTML;
}
