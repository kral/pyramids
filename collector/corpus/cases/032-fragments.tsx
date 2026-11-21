import { Fragment } from 'react';
import * as R from 'react';
export function Frag({ items, show }: { items: string[]; show: boolean }) {
  return (
    <>
      <>nested<>deeper</></>
      {items.map((it) => (
        <Fragment key={it}>
          <dt>{it}</dt>
          <dd>{it.toUpperCase()}</dd>
        </Fragment>
      ))}
      {show ? <><i>a</i><i>b</i></> : /*@never*/ <></>}
      <R.Fragment>member</R.Fragment>
    </>
  );
}
export function scenario(t: any) {
  return t.renderToStaticMarkup(<Frag items={['x', 'y']} show />);
}
