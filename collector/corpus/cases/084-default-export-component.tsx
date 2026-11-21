import App from './084-default-export-component';
export default function ({ who = 'world' }: { who?: string }) {
  return <h1>{who === '' ? /*@never*/ 'empty' : `hello ${who}`}</h1>;
}
export function scenario(t: any) { return { html: t.renderToStaticMarkup(<App who="vto" />), name: App.name }; }
