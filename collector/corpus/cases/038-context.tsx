import { createContext, useContext, use, type ReactNode } from 'react';
const Theme = createContext<'light' | 'dark'>('light');
const User = createContext<{ name: string } | null>(null);
function Label() {
  const theme = useContext(Theme);
  const user = use(User);
  return <span className={theme}>{user?.name ?? 'anon'}</span>;
}
function Consumer() { return <Theme.Consumer>{(v) => v === 'dark' ? <b>dark!</b> : <i>{v}</i>}</Theme.Consumer>; }
function Wrap({ children, dark }: { children: ReactNode; dark?: boolean }) {
  return dark ? <Theme value="dark">{children}</Theme> : <Theme.Provider value="light">{children}</Theme.Provider>;
}
export function App() {
  return (
    <div>
      <Label />
      <Wrap dark><User value={{ name: 'Jana' }}><Label /><Consumer /></User></Wrap>
      <Wrap><Label /><Consumer /></Wrap>
    </div>
  );
}
export function scenario(t: any) { return t.renderToStaticMarkup(<App />); }
