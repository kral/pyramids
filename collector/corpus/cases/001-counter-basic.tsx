import { useState } from 'react';
export function Counter({ start = 0, step }: { start?: number; step?: number }) {
  const [n, setN] = useState(start);
  const inc = step ?? 1;
  return (
    <button onClick={() => setN(n + inc)} data-big={n > 100 ? /*@never*/ 'yes' : 'no'}>
      {n > 100 ? /*@never*/ 'big' : n}
    </button>
  );
}
export async function scenario(t: any) {
  const { container, getByRole } = t.render(<Counter start={2} />);
  t.fireEvent.click(getByRole('button'));
  t.fireEvent.click(getByRole('button'));
  return { html: container.innerHTML, ssr: t.renderToStaticMarkup(<Counter step={3} />) };
}
