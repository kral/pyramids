const Čudlík = ({ popis }: { popis: string }) => <button title={popis ? `🔘 ${popis}` : /*@never*/ 'nic'}>Klikni → {popis} ✓</button>;
function Ňuňu() { return <p data-emoji="😀😀">Příliš žluťoučký kůň 🐴 úpěl {'ďábelské'} ódy</p>; }
export function Stránka({ jméno }: { jméno?: string }) {
  return (
    <main>
      <Čudlík popis="uložit" />
      <Ňuňu />
      {jméno ? <h1>Ahoj, {jméno} 👋</h1> : <h1>Ahoj, světe 🌍</h1>}
      <span>𝒳 · ‘uvozovky’ — „české“</span>
    </main>
  );
}
export function scenario(t: any) { return [t.renderToStaticMarkup(<Stránka jméno="Jiřina" />), t.renderToStaticMarkup(<Stránka />)]; }
