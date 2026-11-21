import { useState } from 'react';
export function Counter({ label, start = 0 }: { label: string; start?: number }) {
  const [n, setN] = useState(start);
  return (
    <div>
      <button onClick={() => setN(n + 1)}>{label}</button>
      {n > 2 && <span role="status">many</span>}
      <b data-testid="n">{n}</b>
    </div>
  );
}
