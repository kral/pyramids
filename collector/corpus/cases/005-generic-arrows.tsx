import type { ReactNode } from 'react';
export const id = <T,>(x: T) => x;
export const pair = <A, B>(a: A, b: B): [A, B] => [a, b];
export const keysOf = <T extends object>(x: T) => Object.keys(x) as (keyof T)[];
export const asyncId = async <T,>(x: T): Promise<T> => x;
export const withDefault = <T = string,>(x?: T) => x ?? ('dflt' as unknown as T);
export function List<T,>({ items, render }: { items: T[]; render: (t: T, i: number) => ReactNode }) {
  return <ul>{items.map((it, i) => <li key={i}>{render(it, i)}</li>)}</ul>;
}
const Generic = <T extends { label: string },>(p: { item: T }) => <b>{p.item.label}</b>;
export async function scenario(t: any) {
  return {
    a: id(1), p: pair('x', 2), k: keysOf({ q: 1, r: 2 }), as: await asyncId('y'), d: withDefault(), d2: withDefault(5),
    html: t.renderToStaticMarkup(<div><List items={['a', 'b']} render={(s, i) => i > 5 ? /*@never*/ null : <i>{s}</i>} /><Generic item={{ label: 'L' }} /></div>),
  };
}
