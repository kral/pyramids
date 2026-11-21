// CRLF JSX
export function C({ items }: { items: string[] }) {
  return (
    <ul
      className={items.length
        ? 'full'
        : /*@never*/ 'empty'}
    >
      {items.map((i) =>
        i.length > 1 &&
        <li key={i}>
          {i}
        </li>
      )}
      text with
      newlines
    </ul>
  );
}
export function scenario(t: any) { return t.renderToStaticMarkup(<C items={['ab', 'c', 'de']} />); }
