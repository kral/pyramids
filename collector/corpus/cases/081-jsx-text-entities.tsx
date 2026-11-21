export function Txt({ n }: { n: number }) {
  return (
    <p>
      a&nbsp;b &amp; &lt;tag&gt; &copy; &#x1F600; &#169;
      {'{'}braces{'}'}
      {/* jsx comment */}
      {
        // line comment in container
      }
      multi   spaced
         text
      {n > 1 ? 'many' : /*@never*/ 'few'} {n}
      {`template ${n}`}{' '}end
    </p>
  );
}
export function scenario(t: any) { return t.renderToStaticMarkup(<Txt n={3} />); }
