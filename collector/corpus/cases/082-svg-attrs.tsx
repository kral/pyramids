export function Icon({ big, title }: { big?: boolean; title?: string }) {
  return (
    <svg viewBox="0 0 10 10" width={big ? 20 : 10} xmlnsXlink="http://www.w3.org/1999/xlink" aria-labelledby={title && 't'}>
      {title ? <title id="t">{title}</title> : null}
      <use xlinkHref="#a" strokeWidth={big ? 2 : 1} />
      <path d="M0 0L10 10" fillOpacity={0.5} className={big ? 'b' : undefined} />
      <foreignObject><div data-x={big ? 'y' : /*@never*/ 'n'} hidden={false} /></foreignObject>
    </svg>
  );
}
export function scenario(t: any) { return [t.renderToStaticMarkup(<Icon big title="T" />), t.renderToStaticMarkup(<Icon big />)]; }
