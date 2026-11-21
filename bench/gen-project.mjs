#!/usr/bin/env node
// Generates the vto benchmark fixture: a React + TSX project (components, custom hooks, context,
// reducer, async effects with a vi.mock'd API module, forms, Czech diacritics) with ~300 test
// files / ~3000 tests and deliberately planted duplicate / subsumed tests.
//
//   node vto/bench/gen-project.mjs [targetDir=/home/claude/bench-project] [--seed N] [--files-per-module N] [--no-verify]
//
// Ground truth is independent of vto: every source module is ALSO rendered as a "probe" copy
// (.vto-probe/src) with explicit __probe('id') calls on every function entry / branch arm /
// short-circuit, mirroring vto v2's atoms. `.vto-probe/vitest.config.ts` swaps the sources at
// load time and records the probe set per test. EXPECTED.json is computed from that run.
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const target = path.resolve(args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? '/home/claude/bench-project');
const seed = Number(args[args.indexOf('--seed') + 1]) || 20261120;
const verify = !args.includes('--no-verify');

// ------------------------------------------------------------------ rng
let s0 = seed >>> 0;
const rnd = () => { s0 = (s0 + 0x6D2B79F5) >>> 0; let t = s0; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const shuffle = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const q = (s) => JSON.stringify(s); // JS string literal
const lc = (s) => s[0].toLowerCase() + s.slice(1);

// ------------------------------------------------------------------ probe helpers
// P(id) → statement probe, E(id, expr) → expression probe, SC(id, expr) → && short-circuit probe
function probes(mod, on) {
  const id = (x) => q(`${mod}:${x}`);
  return {
    P: (x) => (on ? `__probe(${id(x)});` : ''),
    E: (x, e) => (on ? `(__probe(${id(x)}), ${e})` : e),
    SC: (x, e) => (on ? `__probeAnd(${id(x)}, ${e})` : e),
  };
}

// ------------------------------------------------------------------ data
const CZ_NAMES = ['Jan Novák', 'Žofie Dvořáková', 'Čeněk Šťastný', 'Řehoř Kříž', 'Ludmila Úlehlová', 'Ondřej Bříza', 'Tereza Malá', 'Ďuro Ťapák'];
const CZ_WORDS = ['jablko', 'hruška', 'švestka', 'třešeň', 'meruňka', 'broskev', 'řeřicha', 'ředkvička', 'čočka', 'žampion', 'dýně', 'okurka', 'rajče', 'paprika', 'cibule', 'česnek'];

const modules = []; // { name, file (src-relative), group, render(P,E,SC) → code, tests: scenario API }

// ====== 1. Badge ======================================================================
const BADGES = [['CartBadge', 9], ['NotificationBadge', 99], ['StockBadge', 50], ['MessageBadge', 20], ['TaskBadge', 5]];
for (const [name, max] of BADGES) {
  const tid = name.replace(/[A-Z]/g, (m, i) => (i ? '-' : '') + m.toLowerCase());
  const label = (n) => (n > max ? `${max}+` : String(n));
  const cls = (tone) => (tone === 'warn' ? 'badge badge-warn' : 'badge');
  modules.push({
    name, group: 'badges', file: `components/badges/${name}.tsx`,
    render: ({ P, E }) => `import type { ReactElement } from 'react';

export interface ${name}Props {
  count: number;
  tone?: 'info' | 'warn';
}

/** Odznak s počtem – nad ${max} zobrazí „${max}+“. */
export function ${name}({ count, tone }: ${name}Props): ReactElement | null {
  ${P('f')}
  if (count <= 0) {
    ${P('hidden')}
    return null;
  } else {
    ${P('shown')}
    let label: string;
    if (count > ${max}) {
      ${P('over')}
      label = \`${max}+\`;
    } else {
      ${P('under')}
      label = String(count);
    }
    const cls = tone === 'warn' ? ${E('warn', "'badge badge-warn'")} : ${E('info', "'badge'")};
    return (
      <span className={cls} data-testid="${tid}" title={\`Počet: \${count}\`}>
        {label}
      </span>
    );
  }
}
`,
    imports: [`import { ${name} } from '../../src/components/badges/${name}';`],
    rtl: ['render', 'screen'],
    scen: {
      text(c) {
        c ??= pick(['over', 'under']); const n = c === 'over' ? ri(max + 1, max * 3 + 5) : ri(1, max);
        const tone = pick([undefined, 'info']);
        return { c, name: `zobrazí ${label(n)} pro count=${n}`, body: [`render(<${name} count={${n}}${tone ? ` tone="${tone}"` : ''} />);`, `expect(screen.getByTestId('${tid}').textContent).toBe(${q(label(n))});`] };
      },
      tone(c) {
        c ??= pick(['warn', 'info']); const n = ri(1, max);
        return { c, name: `třída pro tón ${c} (${n})`, body: [`render(<${name} count={${n}} tone="${c}" />);`, `expect(screen.getByTestId('${tid}').className).toBe(${q(cls(c))});`] };
      },
      hidden(c) {
        c = 'hidden'; const n = pick([0, -1, -ri(2, 9)]);
        return { c, name: `skryje se pro count=${n}`, body: [`const { container } = render(<${name} count={${n}} />);`, `expect(container.firstChild).toBeNull();`] };
      },
      titleAttr(c) {
        c ??= pick(['title-over', 'title-under']); const n = c === 'title-over' ? ri(max + 1, max * 2) : ri(1, max);
        return { c, name: `title obsahuje počet ${n}`, body: [`render(<${name} count={${n}} tone="warn" />);`, `expect(screen.getByTestId('${tid}').getAttribute('title')).toBe(${q(`Počet: ${n}`)});`] };
      },
    },
    hook() {
      const n = ri(max + 1, max + 40);
      return { name: 'vykreslený s přetečením', hook: [`render(<${name} count={${n}} tone="warn" />);`], tests: [
        { name: 'ukazuje limit', body: [`expect(screen.getByTestId('${tid}').textContent).toBe(${q(label(n))});`] },
        { name: 'má varovnou třídu', body: [`expect(screen.getByTestId('${tid}').className).toBe('badge badge-warn');`] },
        { name: 'title s přesným počtem', body: [`expect(screen.getByTestId('${tid}').getAttribute('title')).toBe(${q(`Počet: ${n}`)});`] },
      ] };
    },
    each() {
      const rows = shuffle([ri(1, max), ri(1, max), ri(1, max), ri(max + 1, max + 9), ri(max + 10, max + 99)]);
      return { title: 'count %s', params: '(_label, n, expected)', rows: rows.map((n) => `[${q(String(n))}, ${n}, ${q(label(n))}]`),
        body: [`render(<${name} count={n as number} />);`, `expect(screen.getByTestId('${tid}').textContent).toBe(expected);`] };
    },
    journey: null,
  });
}

// ====== 2. Disclosure ==================================================================
const DISCL = [['FaqItem', 'Jak vrátit zboží?', 'Zboží můžete vrátit do 14 dnů.'], ['FilterPanel', 'Filtry', 'Cena, značka, hodnocení'],
  ['ShippingInfo', 'Doprava', 'Doručení do 2 pracovních dnů'], ['ReturnPolicy', 'Reklamace', 'Záruka 24 měsíců'], ['SizeGuide', 'Tabulka velikostí', 'Změřte obvod hrudníku']];
for (const [name, title, content] of DISCL) {
  modules.push({
    name, group: 'disclosure', file: `components/disclosure/${name}.tsx`,
    render: ({ P, E, SC }) => `import { useState } from 'react';

export interface ${name}Props {
  title?: string;
  initiallyOpen?: boolean;
}

export function ${name}({ title = ${E('dfltTitle', q(title))}, initiallyOpen = ${E('dfltOpen', 'false')} }: ${name}Props) {
  ${P('f')}
  const [open, setOpen] = useState(initiallyOpen);
  const toggle = () => {
    ${P('toggle')}
    setOpen(!open);
  };
  return (
    <section className="disclosure">
      <button type="button" aria-expanded={open} onClick={toggle}>
        {title}
      </button>
      {${SC('closed', 'open')} && ${E('panel', `(
        <div role="region" aria-label={title}>
          ${content}
        </div>
      )`)}}
    </section>
  );
}
`,
    imports: [`import { ${name} } from '../../src/components/disclosure/${name}';`, `import userEvent from '@testing-library/user-event';`],
    rtl: ['render', 'screen', 'fireEvent'],
    scen: {
      closed(c) {
        c ??= pick(['closed-dflt', 'closed-title']); const t = c === 'closed-dflt' ? null : 'Otázka č. ' + ri(1, 99);
        return { c, name: `zavřený ve výchozím stavu${t ? ` (${t})` : ''}`, body: [`render(<${name}${t ? ` title=${q(t)}` : ''} />);`, `expect(screen.queryByRole('region')).toBeNull();`] };
      },
      explicitClosed(c) {
        c = 'explicitClosed';
        return { c, name: `initiallyOpen={false} je zavřený`, body: [`render(<${name} initiallyOpen={false} />);`, `expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false');`] };
      },
      open(c) {
        c = 'open';
        return { c, name: `otevřený přes initiallyOpen`, body: [`render(<${name} initiallyOpen />);`, `expect(screen.getByRole('region').textContent).toContain(${q(content.slice(0, 8))});`] };
      },
      clickUser(c) {
        c = 'click';
        return { c, async: true, name: `otevře se po kliknutí (userEvent)`, body: [`const user = userEvent.setup();`, `render(<${name} />);`, `await user.click(screen.getByRole('button'));`, `expect(screen.getByRole('region')).toBeTruthy();`] };
      },
      clickFire(c) {
        c = 'click';
        return { c, name: `otevře se po kliknutí (fireEvent)`, body: [`render(<${name} />);`, `fireEvent.click(screen.getByRole('button'));`, `expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');`] };
      },
      twice(c) {
        c = 'click';
        return { c, name: `dvojí klik ho zase zavře`, body: [`render(<${name} />);`, `fireEvent.click(screen.getByRole('button'));`, `fireEvent.click(screen.getByRole('button'));`, `expect(screen.queryByRole('region')).toBeNull();`] };
      },
    },
    hook() {
      return { name: 'otevřený panel', hook: [`render(<${name} initiallyOpen title="Detail" />);`], tests: [
        { name: 'obsah je vidět', body: [`expect(screen.getByRole('region').textContent).toContain(${q(content.slice(0, 5))});`] },
        { name: 'aria-expanded je true', body: [`expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');`] },
        { name: 'klik panel zavře', body: [`fireEvent.click(screen.getByRole('button'));`, `expect(screen.queryByRole('region')).toBeNull();`] },
      ] };
    },
    each: null,
    journey() {
      return {
        full: { name: 'celý průchod: otevřít, zavřít, otevřít', async: true, body: [`const user = userEvent.setup();`, `render(<${name} title="Průchod" />);`, `expect(screen.queryByRole('region')).toBeNull();`, `await user.click(screen.getByRole('button'));`, `await user.click(screen.getByRole('button'));`, `await user.click(screen.getByRole('button'));`, `expect(screen.getByRole('region')).toBeTruthy();`] },
        part: { name: 'vlastní titulek se zobrazí', body: [`render(<${name} title="Průchod" />);`, `expect(screen.getByRole('button').textContent).toBe('Průchod');`] },
      };
    },
  });
}

// ====== 3. Counter: reducer + hook + component ==========================================
const COUNTERS = [['Quantity', 1, 1, 10], ['Rating', 1, 0, 5], ['Guests', 2, 1, 12], ['Pages', 5, 5, 50], ['Volume', 10, 0, 100]];
for (const [name, step, min, max] of COUNTERS) {
  const red = `${lc(name)}Reducer`, hook = `use${name}`, comp = `${name}Stepper`;
  const R = (count, a) => {
    if (a.type === 'inc') return count + step > max ? max : count + step;
    if (a.type === 'dec') return count - step < min ? min : count - step;
    if (a.type === 'reset') return min;
    return a.value;
  };
  modules.push({
    name, group: 'counters', file: `hooks/${hook}.tsx`,
    render: ({ P, E }) => `import { useReducer } from 'react';

export interface ${name}State {
  count: number;
}
export type ${name}Action = { type: 'inc' } | { type: 'dec' } | { type: 'reset' } | { type: 'set'; value: number };

export const ${name.toUpperCase()}_LIMITS = { step: ${step}, min: ${min}, max: ${max} } as const;

export function ${red}(state: ${name}State, action: ${name}Action): ${name}State {
  ${P('red')}
  switch (action.type) {
    case 'inc': {
      ${P('inc')}
      if (state.count + ${step} > ${max}) {
        ${P('cap')}
        return { count: ${max} };
      } else {
        ${P('add')}
        return { count: state.count + ${step} };
      }
    }
    case 'dec': {
      ${P('dec')}
      if (state.count - ${step} < ${min}) {
        ${P('floor')}
        return { count: ${min} };
      } else {
        ${P('sub')}
        return { count: state.count - ${step} };
      }
    }
    case 'reset': {
      ${P('reset')}
      return { count: ${min} };
    }
    default: {
      ${P('set')}
      return { count: action.value };
    }
  }
}

export function ${hook}(initial: number = ${E('dflt', String(min))}) {
  ${P('hook')}
  const [state, dispatch] = useReducer(${red}, { count: initial });
  const inc = () => {
    ${P('incFn')}
    dispatch({ type: 'inc' });
  };
  const dec = () => {
    ${P('decFn')}
    dispatch({ type: 'dec' });
  };
  const reset = () => {
    ${P('resetFn')}
    dispatch({ type: 'reset' });
  };
  const set = (value: number) => {
    ${P('setFn')}
    dispatch({ type: 'set', value });
  };
  return { count: state.count, inc, dec, reset, set };
}

export function ${comp}({ initial }: { initial?: number }) {
  ${P('comp')}
  const c = ${hook}(initial);
  return (
    <div className="stepper">
      <button type="button" aria-label="Méně" onClick={c.dec}>
        −
      </button>
      <output>{c.count}</output>
      <button type="button" aria-label="Více" onClick={c.inc}>
        +
      </button>
      <button type="button" onClick={c.reset}>
        Vynulovat
      </button>
    </div>
  );
}
`,
    imports: [`import { ${red}, ${hook}, ${comp} } from '../../src/hooks/${hook}';`, `import userEvent from '@testing-library/user-event';`],
    rtl: ['render', 'screen', 'renderHook', 'act', 'fireEvent'],
    scen: {
      redInc(c) {
        c ??= pick(['add', 'cap']); const a = c === 'add' ? ri(min, max - step) : ri(max - step + 1, max);
        return { c: 'r-' + c, name: `reducer inc z ${a}`, body: [`expect(${red}({ count: ${a} }, { type: 'inc' })).toEqual({ count: ${R(a, { type: 'inc' })} });`] };
      },
      redDec(c) {
        c ??= pick(['sub', 'floor']); const a = c === 'sub' ? ri(min + step, max) : ri(min - 3, min + step - 1);
        return { c: 'r-' + c, name: `reducer dec z ${a}`, body: [`expect(${red}({ count: ${a} }, { type: 'dec' })).toEqual({ count: ${R(a, { type: 'dec' })} });`] };
      },
      redReset(c) {
        const a = ri(min, max);
        return { c: 'r-reset', name: `reducer reset z ${a}`, body: [`expect(${red}({ count: ${a} }, { type: 'reset' }).count).toBe(${min});`] };
      },
      hookInc(c) {
        c ??= pick(['add', 'cap']); const a = c === 'add' ? ri(min, max - step) : max;
        return { c: 'h-' + c, name: `hook inc z ${a}`, body: [`const { result } = renderHook(() => ${hook}(${a}));`, `act(() => result.current.inc());`, `expect(result.current.count).toBe(${R(a, { type: 'inc' })});`] };
      },
      hookDefault(c) {
        return { c: 'h-dflt', name: `hook výchozí hodnota`, body: [`const { result } = renderHook(() => ${hook}());`, `expect(result.current.count).toBe(${min});`] };
      },
      hookSet(c) {
        const v = ri(min, max);
        return { c: 'h-set', name: `hook set na ${v}`, body: [`const { result } = renderHook(() => ${hook}(${min}));`, `act(() => result.current.set(${v}));`, `expect(result.current.count).toBe(${v});`] };
      },
      compClick(c) {
        c ??= pick(['inc', 'dec']); const a = ri(min + step, max - step);
        const label = c === 'inc' ? 'Více' : 'Méně';
        return { c: 'c-' + c, async: true, name: `stepper ${c} z ${a}`, body: [`const user = userEvent.setup();`, `const { container } = render(<${comp} initial={${a}} />);`, `await user.click(screen.getByLabelText(${q(label)}));`, `expect(container.querySelector('output')!.textContent).toBe(${q(String(R(a, { type: c })))});`] };
      },
      compInitial(c) {
        const a = ri(min, max);
        return { c: 'c-init', name: `stepper ukáže počáteční ${a}`, body: [`const { container } = render(<${comp} initial={${a}} />);`, `expect(container.querySelector('output')!.textContent).toBe(${q(String(a))});`] };
      },
    },
    hook() {
      return { name: 'vykreslený stepper', hook: [`render(<${comp} />);`], tests: [
        { name: 'začíná na minimu', body: [`expect(document.querySelector('output')!.textContent).toBe(${q(String(min))});`] },
        { name: 'má tlačítko Více', body: [`expect(screen.getByLabelText('Více')).toBeTruthy();`] },
        { name: 'Méně nejde pod minimum', body: [`fireEvent.click(screen.getByLabelText('Méně'));`, `expect(document.querySelector('output')!.textContent).toBe(${q(String(min))});`] },
      ] };
    },
    each() {
      const rows = [];
      for (let k = 0; k < 5; k++) { const a = ri(min, max - step); rows.push(`[${q(`inc ${a}`)}, ${a}, 'inc', ${R(a, { type: 'inc' })}]`); }
      const d = ri(min, min + step - 1); rows.push(`[${q(`dec ${d}`)}, ${d}, 'dec', ${R(d, { type: 'dec' })}]`);
      return { title: 'reducer %s', params: '(_l, a, type, expected)', rows: shuffle(rows),
        body: [`expect(${red}({ count: a as number }, { type: type as 'inc' | 'dec' }).count).toBe(expected);`] };
    },
    journey() {
      const a = ri(min + step, max - 2 * step); let v = R(a, { type: 'inc' }); v = R(v, { type: 'inc' }); v = R(v, { type: 'dec' });
      return {
        full: { name: 'průchod: +, +, −, vynulovat', async: true, body: [`const user = userEvent.setup();`, `const { container } = render(<${comp} initial={${a}} />);`, `await user.click(screen.getByLabelText('Více'));`, `await user.click(screen.getByLabelText('Více'));`, `await user.click(screen.getByLabelText('Méně'));`, `expect(container.querySelector('output')!.textContent).toBe(${q(String(v))});`, `await user.click(screen.getByText('Vynulovat'));`, `expect(container.querySelector('output')!.textContent).toBe(${q(String(min))});`] },
        part: { name: 'klik na Více zvýší hodnotu', body: [`const { container } = render(<${comp} initial={${a}} />);`, `fireEvent.click(screen.getByLabelText('Více'));`, `expect(container.querySelector('output')!.textContent).toBe(${q(String(R(a, { type: 'inc' })))});`] },
      };
    },
  });
}

// ====== 4. async data hook + card, vi.mock'd API ==========================================
const DATA = [['UserCard', 'fetchUser', 'users'], ['OrderStatus', 'fetchOrder', 'orders'], ['InvoicePreview', 'fetchInvoice', 'invoices'],
  ['ProductReviews', 'fetchReviews', 'reviews'], ['StockLevel', 'fetchStock', 'stock']];
modules.push({
  name: 'client', group: null, file: 'api/client.ts', untested: true,
  render: () => `// HTTP klient – v testech je vždy nahrazen přes vi.mock().
export interface Entity {
  id: number;
  name: string;
}

const BASE = 'https://api.example.test';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(\`\${BASE}\${path}\`);
  if (!res.ok) {
    throw new Error(\`HTTP \${res.status}\`);
  } else {
    return (await res.json()) as T;
  }
}
${DATA.map(([, fn, p]) => `
export function ${fn}(id: number): Promise<Entity> {
  return getJson<Entity>(\`/${p}/\${id}\`);
}`).join('\n')}
`,
});
for (const [name, fn] of DATA) {
  const hook = `use${name}`;
  modules.push({
    name, group: 'data', file: `components/data/${name}.tsx`,
    render: ({ P, E }) => `import { useEffect, useState } from 'react';
import { ${fn}, type Entity } from '../../api/client';

export type ${name}State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; data: Entity }
  | { status: 'error'; message: string };

export function ${hook}(id: number | null): ${name}State {
  ${P('hook')}
  const [state, setState] = useState<${name}State>({ status: 'idle' });
  useEffect(() => {
    ${P('eff')}
    if (id === null) {
      ${P('noid')}
      setState({ status: 'idle' });
      return undefined;
    } else {
      ${P('load')}
      let cancelled = false;
      setState({ status: 'loading' });
      ${fn}(id).then(
        (data) => {
          ${P('ok')}
          if (cancelled) {
            ${P('okLate')}
          } else {
            ${P('okApply')}
            setState({ status: 'ok', data });
          }
        },
        (err: unknown) => {
          ${P('fail')}
          if (cancelled) {
            ${P('failLate')}
          } else {
            ${P('failApply')}
            setState({ status: 'error', message: err instanceof Error ? ${E('errMsg', 'err.message')} : ${E('errOther', "'Neznámá chyba'")} });
          }
        },
      );
      return () => {
        ${P('cleanup')}
        cancelled = true;
      };
    }
  }, [id]);
  return state;
}

export function ${name}({ id }: { id: number | null }) {
  ${P('comp')}
  const s = ${hook}(id);
  if (s.status === 'idle') {
    ${P('idle')}
    return <p>Vyberte záznam</p>;
  } else if (s.status === 'loading') {
    ${P('loading')}
    return <p role="progressbar">Načítám…</p>;
  } else if (s.status === 'error') {
    ${P('error')}
    return <p role="alert">Chyba: {s.message}</p>;
  } else {
    ${P('okView')}
    return (
      <article>
        <h2>{s.data.name}</h2>
        <small>#{s.data.id}</small>
      </article>
    );
  }
}
`,
    imports: [`import { ${name}, ${hook} } from '../../src/components/data/${name}';`, `import { ${fn} } from '../../src/api/client';`],
    rtl: ['render', 'screen', 'renderHook', 'waitFor'],
    vi: [`vi.mock('../../src/api/client', () => ({ ${DATA.map(([, f]) => `${f}: vi.fn()`).join(', ')} }));`],
    pre: [`beforeEach(() => {`, `  vi.mocked(${fn}).mockReset();`, `});`],
    scen: {
      ok(c) {
        const id = ri(1, 999), nm = pick(CZ_NAMES);
        return { c: 'ok', async: true, name: `načte a zobrazí ${nm} (#${id})`, body: [`vi.mocked(${fn}).mockResolvedValueOnce({ id: ${id}, name: ${q(nm)} });`, `render(<${name} id={${id}} />);`, `expect((await screen.findByRole('heading')).textContent).toBe(${q(nm)});`, `expect(${fn}).toHaveBeenCalledWith(${id});`] };
      },
      error(c) {
        const msg = pick(['Server neodpovídá', 'Přístup odepřen', 'Záznam nenalezen']);
        return { c: 'err', async: true, name: `ukáže chybu „${msg}“`, body: [`vi.mocked(${fn}).mockRejectedValueOnce(new Error(${q(msg)}));`, `render(<${name} id={${ri(1, 99)}} />);`, `expect((await screen.findByRole('alert')).textContent).toBe(${q('Chyba: ' + msg)});`] };
      },
      errorOther(c) {
        return { c: 'errOther', async: true, name: `neznámá chyba pro ne-Error rejection`, body: [`vi.mocked(${fn}).mockRejectedValueOnce('timeout');`, `render(<${name} id={1} />);`, `expect((await screen.findByRole('alert')).textContent).toBe('Chyba: Neznámá chyba');`] };
      },
      idle(c) {
        return { c: 'idle', name: `bez id vyzve k výběru`, body: [`render(<${name} id={null} />);`, `expect(screen.getByText('Vyberte záznam')).toBeTruthy();`, `expect(${fn}).not.toHaveBeenCalled();`] };
      },
      loading(c) {
        return { c: 'loading', name: `během načítání ukazuje progress`, body: [`vi.mocked(${fn}).mockReturnValueOnce(new Promise(() => {}));`, `render(<${name} id={5} />);`, `expect(screen.getByRole('progressbar').textContent).toBe('Načítám…');`] };
      },
      unmount(c) {
        return { c: 'unmount', async: true, name: `odpověď po odpojení se ignoruje`, body: [`let resolve!: (v: { id: number; name: string }) => void;`, `vi.mocked(${fn}).mockReturnValueOnce(new Promise((r) => { resolve = r; }));`, `const { unmount } = render(<${name} id={3} />);`, `unmount();`, `resolve({ id: 3, name: 'Pozdě' });`, `await Promise.resolve();`, `expect(screen.queryByText('Pozdě')).toBeNull();`] };
      },
      hookOk(c) {
        const id = ri(1, 50);
        return { c: 'hookOk', async: true, name: `hook přejde do stavu ok (#${id})`, body: [`vi.mocked(${fn}).mockResolvedValueOnce({ id: ${id}, name: 'Hák' });`, `const { result } = renderHook(() => ${hook}(${id}));`, `await waitFor(() => expect(result.current.status).toBe('ok'));`] };
      },
      hookRerender(c) {
        return { c: 'hookRerender', async: true, name: `hook při změně id zruší předchozí požadavek`, body: [`vi.mocked(${fn}).mockResolvedValueOnce({ id: 1, name: 'První' }).mockResolvedValueOnce({ id: 2, name: 'Druhý' });`, `const { result, rerender } = renderHook(({ id }) => ${hook}(id), { initialProps: { id: 1 as number | null } });`, `rerender({ id: 2 });`, `await waitFor(() => expect(result.current).toEqual({ status: 'ok', data: { id: 2, name: 'Druhý' } }));`] };
      },
    },
    hook() {
      return { name: 'načtený záznam', async: true, hook: [`vi.mocked(${fn}).mockResolvedValueOnce({ id: 42, name: 'Žofie Dvořáková' });`, `render(<${name} id={42} />);`, `await screen.findByRole('heading');`], tests: [
        { name: 'jméno v nadpisu', body: [`expect(screen.getByRole('heading').textContent).toBe('Žofie Dvořáková');`] },
        { name: 'číslo záznamu', body: [`expect(screen.getByText('#42')).toBeTruthy();`] },
        { name: 'API voláno jednou', body: [`expect(${fn}).toHaveBeenCalledTimes(1);`] },
      ] };
    },
    each: null,
    journey: null,
  });
}

// ====== 5. context provider / hook / consumer ============================================
const CTX = [['Theme', 'light', 'dark', '☀ Světlý režim', '🌙 Tmavý režim'], ['Locale', 'cs', 'en', 'Čeština', 'English'],
  ['Currency', 'CZK', 'EUR', 'Kč', '€'], ['Density', 'compact', 'comfortable', 'Úsporné', 'Vzdušné'], ['Layout', 'grid', 'list', 'Mřížka', 'Seznam']];
for (const [name, a, b, la, lb] of CTX) {
  const Prov = `${name}Provider`, use = `use${name}`, Tog = `${name}Toggle`;
  modules.push({
    name, group: 'context', file: `context/${name}Context.tsx`,
    render: ({ P, E }) => `import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

export type ${name}Mode = '${a}' | '${b}';

interface ${name}Value {
  mode: ${name}Mode;
  toggle: () => void;
}

const ${name}Context = createContext<${name}Value | null>(null);

export function ${Prov}({ children, initial }: { children: ReactNode; initial?: ${name}Mode }) {
  ${P('prov')}
  const [mode, setMode] = useState<${name}Mode>(initial === undefined ? ${E('dflt', `'${a}'`)} : ${E('given', 'initial')});
  const value = useMemo(() => {
    ${P('memo')}
    return {
      mode,
      toggle: () => {
        ${P('toggle')}
        setMode(mode === '${a}' ? ${E('toB', `'${b}'`)} : ${E('toA', `'${a}'`)});
      },
    };
  }, [mode]);
  return <${name}Context.Provider value={value}>{children}</${name}Context.Provider>;
}

export function ${use}(): ${name}Value {
  ${P('use')}
  const v = useContext(${name}Context);
  if (v === null) {
    ${P('missing')}
    throw new Error('${use} musí být použit uvnitř <${Prov}>');
  } else {
    ${P('found')}
    return v;
  }
}

export function ${Tog}() {
  ${P('tog')}
  const { mode, toggle } = ${use}();
  return (
    <button type="button" onClick={toggle} data-mode={mode}>
      {mode === '${a}' ? ${E('labA', q(la))} : ${E('labB', q(lb))}}
    </button>
  );
}
`,
    imports: [`import { ${Prov}, ${use}, ${Tog} } from '../../src/context/${name}Context';`, `import type { ReactNode } from 'react';`, `import userEvent from '@testing-library/user-event';`],
    rtl: ['render', 'screen', 'renderHook', 'act', 'fireEvent'],
    scen: {
      label(c) {
        c ??= pick(['dflt', 'givenA', 'givenB']);
        const init = c === 'dflt' ? '' : c === 'givenA' ? ` initial="${a}"` : ` initial="${b}"`;
        return { c, name: `popisek pro ${c === 'givenB' ? b : a}${c === 'dflt' ? ' (výchozí)' : ''}`, body: [`render(<${Prov}${init}><${Tog} /></${Prov}>);`, `expect(screen.getByRole('button').textContent).toBe(${q(c === 'givenB' ? lb : la)});`] };
      },
      toggle(c) {
        return { c: 'toggle', async: true, name: `přepne ${a} → ${b}`, body: [`const user = userEvent.setup();`, `render(<${Prov}><${Tog} /></${Prov}>);`, `await user.click(screen.getByRole('button'));`, `expect(screen.getByRole('button').getAttribute('data-mode')).toBe('${b}');`] };
      },
      hookWrapper(c) {
        return { c: 'hookW', name: `${use} vrací režim z provideru`, body: [`const wrapper = ({ children }: { children: ReactNode }) => <${Prov} initial="${b}">{children}</${Prov}>;`, `const { result } = renderHook(() => ${use}(), { wrapper });`, `expect(result.current.mode).toBe('${b}');`] };
      },
      hookToggle(c) {
        return { c: 'hookT', name: `${use}.toggle přepíná zpět`, body: [`const wrapper = ({ children }: { children: ReactNode }) => <${Prov} initial="${b}">{children}</${Prov}>;`, `const { result } = renderHook(() => ${use}(), { wrapper });`, `act(() => result.current.toggle());`, `expect(result.current.mode).toBe('${a}');`] };
      },
      missing(c) {
        return { c: 'missing', name: `bez provideru vyhodí chybu`, body: [`const spy = vi.spyOn(console, 'error').mockImplementation(() => {});`, `expect(() => renderHook(() => ${use}())).toThrow('${use} musí být použit uvnitř <${Prov}>');`, `spy.mockRestore();`] };
      },
    },
    hook() {
      return { name: 'v provideru', hook: [`render(<${Prov}><${Tog} /></${Prov}>);`], tests: [
        { name: 'výchozí režim', body: [`expect(screen.getByRole('button').getAttribute('data-mode')).toBe('${a}');`] },
        { name: 'výchozí popisek', body: [`expect(screen.getByRole('button').textContent).toBe(${q(la)});`] },
        { name: 'dvojí přepnutí vrátí výchozí', body: [`fireEvent.click(screen.getByRole('button'));`, `fireEvent.click(screen.getByRole('button'));`, `expect(screen.getByRole('button').textContent).toBe(${q(la)});`] },
      ] };
    },
    each: null,
    journey() {
      return {
        full: { name: 'průchod: výchozí, přepnout, přepnout zpět', async: true, body: [`const user = userEvent.setup();`, `render(<${Prov}><${Tog} /></${Prov}>);`, `expect(screen.getByRole('button').textContent).toBe(${q(la)});`, `await user.click(screen.getByRole('button'));`, `expect(screen.getByRole('button').textContent).toBe(${q(lb)});`, `await user.click(screen.getByRole('button'));`, `expect(screen.getByRole('button').textContent).toBe(${q(la)});`] },
        part: { name: 'výchozí režim je ' + a, body: [`render(<${Prov}><${Tog} /></${Prov}>);`, `expect(screen.getByRole('button').getAttribute('data-mode')).toBe('${a}');`] },
      };
    },
  });
}

// ====== 6. filtered list =================================================================
const LISTS = ['ProductList', 'CategoryList', 'BrandList', 'TagList', 'CityList'];
for (const name of LISTS) {
  const shown = (items, query) => items.filter((it) => it.toLowerCase().includes(query.trim().toLowerCase()));
  modules.push({
    name, group: 'lists', file: `components/lists/${name}.tsx`,
    render: ({ P, E }) => `export interface ${name}Props {
  items: string[];
  query?: string;
}

export function ${name}({ items, query = ${E('dflt', "''")} }: ${name}Props) {
  ${P('f')}
  const q = query.trim().toLowerCase();
  const shown = items.filter((it) => {
    ${P('filter')}
    return it.toLowerCase().includes(q);
  });
  if (shown.length === 0) {
    ${P('empty')}
    return <p role="status">{items.length === 0 ? ${E('none', "'Seznam je prázdný'")} : ${E('nomatch', "'Nic nenalezeno'")}}</p>;
  } else {
    ${P('some')}
    return (
      <ul aria-label="${name}">
        {shown.map((it) => {
          ${P('item')}
          return <li key={it}>{it}</li>;
        })}
        <li className="summary">{\`Zobrazeno \${shown.length} z \${items.length}\`}</li>
      </ul>
    );
  }
}
`,
    imports: [`import { ${name} } from '../../src/components/lists/${name}';`],
    rtl: ['render', 'screen'],
    scen: {
      all(c) {
        const items = shuffle(CZ_WORDS).slice(0, ri(1, 6));
        return { c: 'all', name: `bez dotazu ukáže všech ${items.length}`, body: [`render(<${name} items={${JSON.stringify(items)}} />);`, `expect(screen.getAllByRole('listitem')).toHaveLength(${items.length + 1});`] };
      },
      filtered(c) {
        const items = shuffle(CZ_WORDS).slice(0, ri(3, 8)); const w = pick(items); const qy = w.slice(0, ri(2, 4)).toUpperCase();
        const n = shown(items, qy).length;
        return { c: 'filtered', name: `filtr „${qy}“ najde ${n}`, body: [`render(<${name} items={${JSON.stringify(items)}} query=${q(qy)} />);`, `expect(screen.getByText(${q(`Zobrazeno ${n} z ${items.length}`)})).toBeTruthy();`] };
      },
      nomatch(c) {
        const items = shuffle(CZ_WORDS).slice(0, ri(1, 5));
        return { c: 'nomatch', name: `nic nenajde pro xyz (${items.length} položek)`, body: [`render(<${name} items={${JSON.stringify(items)}} query="xyz" />);`, `expect(screen.getByRole('status').textContent).toBe('Nic nenalezeno');`] };
      },
      none(c) {
        c ??= pick(['none-dflt', 'none-q']); const qy = c === 'none-dflt' ? '' : pick(['a', '  ']);
        return { c, name: `prázdný seznam${qy ? ` (dotaz ${q(qy)})` : ''}`, body: [`render(<${name} items={[]}${qy ? ` query=${q(qy)}` : ''} />);`, `expect(screen.getByRole('status').textContent).toBe('Seznam je prázdný');`] };
      },
    },
    hook() {
      const items = shuffle(CZ_WORDS).slice(0, 5);
      return { name: 'pět položek', hook: [`render(<${name} items={${JSON.stringify(items)}} />);`], tests: [
        { name: 'má souhrn', body: [`expect(screen.getByText('Zobrazeno 5 z 5')).toBeTruthy();`] },
        { name: 'první položka', body: [`expect(screen.getAllByRole('listitem')[0].textContent).toBe(${q(items[0])});`] },
        { name: 'seznam má popisek', body: [`expect(screen.getByRole('list').getAttribute('aria-label')).toBe('${name}');`] },
      ] };
    },
    each() {
      const items = shuffle(CZ_WORDS).slice(0, 8);
      const qs = [items[0].slice(0, 3), items[1].slice(0, 2), items[2], 'zzz', items[3].slice(1, 3)];
      return { title: 'dotaz %s', params: '(query, expected)', rows: qs.map((x) => `[${q(x)}, ${shown(items, x).length}]`),
        body: [`render(<${name} items={${JSON.stringify(items)}} query={query} />);`, `expect(screen.queryAllByRole('listitem').length).toBe(expected === 0 ? 0 : (expected as number) + 1);`] };
    },
    journey: null,
  });
}

// ====== 7. form with validation ==========================================================
const FORMS = [['NewsletterForm', 'E-mail', 5], ['CouponForm', 'Kód kupónu', 4], ['NicknameForm', 'Přezdívka', 3], ['SearchForm', 'Hledat', 2], ['NoteForm', 'Poznámka', 6]];
for (const [name, label, min] of FORMS) {
  const val = `validate${name.replace('Form', '')}`;
  const V = (v) => { const t = v.trim(); if (t.length === 0) return 'Pole je povinné'; if (t.length < min) return `Zadejte alespoň ${min} znaků`; if (/\d/.test(t)) return 'Číslice nejsou povoleny'; return null; };
  const good = () => { let w; do w = pick(CZ_WORDS) + (rnd() < 0.5 ? '' : ' ' + pick(CZ_WORDS)); while (V(w) !== null); return w; };
  modules.push({
    name, group: 'forms', file: `components/forms/${name}.tsx`,
    render: ({ P, E }) => `import { useState, type ChangeEvent, type FormEvent } from 'react';

export function ${val}(value: string): string | null {
  ${P('val')}
  const t = value.trim();
  if (t.length === 0) {
    ${P('req')}
    return 'Pole je povinné';
  } else if (t.length < ${min}) {
    ${P('short')}
    return 'Zadejte alespoň ${min} znaků';
  } else if (/\\d/.test(t)) {
    ${P('digit')}
    return 'Číslice nejsou povoleny';
  } else {
    ${P('valid')}
    return null;
  }
}

export function ${name}({ onSubmit }: { onSubmit: (value: string) => void }) {
  ${P('comp')}
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    ${P('change')}
    setValue(e.target.value);
  };
  const handleSubmit = (e: FormEvent) => {
    ${P('submit')}
    e.preventDefault();
    const err = ${val}(value);
    if (err === null) {
      ${P('ok')}
      setError(null);
      onSubmit(value.trim());
    } else {
      ${P('bad')}
      setError(err);
    }
  };
  return (
    <form onSubmit={handleSubmit} aria-label="${name}">
      <label>
        ${label}
        <input value={value} onChange={handleChange} />
      </label>
      <button type="submit">Odeslat</button>
      {error === null ? ${E('noErr', 'null')} : ${E('err', '<p role="alert">{error}</p>')}}
    </form>
  );
}
`,
    imports: [`import { ${name}, ${val} } from '../../src/components/forms/${name}';`, `import userEvent from '@testing-library/user-event';`],
    rtl: ['render', 'screen', 'fireEvent'],
    scen: {
      valid(c) {
        c ??= pick(['req', 'short', 'digit', 'valid']);
        const v = c === 'req' ? pick(['', '   ']) : c === 'short' ? pick(CZ_WORDS).slice(0, min - 1) : c === 'digit' ? pick(CZ_WORDS).padEnd(min, 'x') + ri(0, 9) : good();
        if (c === 'short' && v.trim().length === 0) return this.valid('req');
        return { c: 'v-' + c, name: `${val}(${q(v)})`, body: [`expect(${val}(${q(v)})).toBe(${V(v) === null ? 'null' : q(V(v))});`] };
      },
      submitOk(c) {
        const v = good();
        return { c: 'submitOk', async: true, name: `odešle platnou hodnotu ${q(v)}`, body: [`const user = userEvent.setup();`, `const onSubmit = vi.fn();`, `render(<${name} onSubmit={onSubmit} />);`, `await user.type(screen.getByLabelText(${q(label)}), ${q('  ' + v)});`, `await user.click(screen.getByText('Odeslat'));`, `expect(onSubmit).toHaveBeenCalledWith(${q(v)});`] };
      },
      submitEmpty(c) {
        return { c: 'submitEmpty', name: `prázdný formulář ukáže chybu`, body: [`const onSubmit = vi.fn();`, `render(<${name} onSubmit={onSubmit} />);`, `fireEvent.submit(screen.getByRole('form'));`, `expect(screen.getByRole('alert').textContent).toBe('Pole je povinné');`, `expect(onSubmit).not.toHaveBeenCalled();`] };
      },
      submitShort(c) {
        const v = 'ab'.slice(0, Math.max(1, Math.min(2, min - 1)));
        if (v.length >= min) return this.submitEmpty();
        return { c: 'submitShort', name: `krátká hodnota ${q(v)} ukáže chybu`, body: [`render(<${name} onSubmit={vi.fn()} />);`, `fireEvent.change(screen.getByLabelText(${q(label)}), { target: { value: ${q(v)} } });`, `fireEvent.submit(screen.getByRole('form'));`, `expect(screen.getByRole('alert').textContent).toBe(${q(V(v))});`] };
      },
      initial(c) {
        return { c: 'initial', name: `na začátku bez chyby`, body: [`render(<${name} onSubmit={vi.fn()} />);`, `expect(screen.queryByRole('alert')).toBeNull();`] };
      },
    },
    hook: null,
    each() {
      const rows = [['', 'prázdné'], ['   ', 'mezery'], [good(), 'platné'], [good(), 'platné 2'], [good(), 'platné 3'], ['a'.repeat(min) + '7', 'číslice']];
      return { title: 'validace: %s', params: '(_l, value)', rows: shuffle(rows).map(([v, l]) => `[${q(l)}, ${q(v)}]`),
        body: [`const expected: Record<string, string | null> = ${JSON.stringify(Object.fromEntries(rows.map(([v]) => [v, V(v)])))};`, `expect(${val}(value)).toBe(expected[value]);`] };
    },
    journey() {
      const v = good();
      return {
        full: { name: 'průchod: chyba, oprava, odeslání', async: true, body: [`const user = userEvent.setup();`, `const onSubmit = vi.fn();`, `render(<${name} onSubmit={onSubmit} />);`, `await user.click(screen.getByText('Odeslat'));`, `expect(screen.getByRole('alert')).toBeTruthy();`, `await user.type(screen.getByLabelText(${q(label)}), ${q(v)});`, `await user.click(screen.getByText('Odeslat'));`, `expect(screen.queryByRole('alert')).toBeNull();`, `expect(onSubmit).toHaveBeenCalledTimes(1);`] },
        part: { name: 'prázdné odeslání zobrazí chybu (klik)', async: true, body: [`const user = userEvent.setup();`, `render(<${name} onSubmit={vi.fn()} />);`, `await user.click(screen.getByText('Odeslat'));`, `expect(screen.getByRole('alert').textContent).toBe('Pole je povinné');`] },
      };
    },
  });
}

// ====== 8. tabs ==========================================================================
const TABS = [['ProductTabs', ['Popis', 'Parametry', 'Recenze', 'Dotazy']], ['AccountTabs', ['Profil', 'Objednávky', 'Adresy', 'Zabezpečení', 'Oznámení']]];
for (const [name, tabs] of TABS) {
  const panel = (i) => [`Obsah: ${tabs[i]}`, `Detail: ${tabs[i]}`, `Další: ${tabs[i]}`][i % 3];
  modules.push({
    name, group: 'tabs', file: `components/${name}.tsx`,
    render: ({ P, E }) => `import { useState } from 'react';

export const ${name.toUpperCase()}_DEFAULT = ${JSON.stringify(tabs)};

function renderPanel(name: string, index: number) {
  ${P('panel')}
  switch (index % 3) {
    case 0: {
      ${P('p0')}
      return <p>{\`Obsah: \${name}\`}</p>;
    }
    case 1: {
      ${P('p1')}
      return <p>{\`Detail: \${name}\`}</p>;
    }
    default: {
      ${P('p2')}
      return <p>{\`Další: \${name}\`}</p>;
    }
  }
}

export function ${name}({ tabs, initial }: { tabs: string[]; initial?: number }) {
  ${P('f')}
  const [active, setActive] = useState(initial === undefined ? ${E('dflt', '0')} : ${E('given', 'initial')});
  return (
    <div>
      <div role="tablist">
        {tabs.map((t, i) => {
          ${P('tab')}
          return (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={i === active}
              onClick={() => {
                ${P('click')}
                setActive(i);
              }}
            >
              {t}
            </button>
          );
        })}
      </div>
      <div role="tabpanel">{renderPanel(tabs[active], active)}</div>
    </div>
  );
}
`,
    imports: [`import { ${name} } from '../../src/components/${name}';`, `import userEvent from '@testing-library/user-event';`],
    rtl: ['render', 'screen', 'fireEvent'],
    scen: {
      initial(c) {
        c ??= pick(['dflt', 'given']); const i = c === 'dflt' ? 0 : ri(0, tabs.length - 1);
        return { c: c + (i % 3), name: `počáteční panel ${tabs[i]}${c === 'dflt' ? ' (výchozí)' : ''}`, body: [`render(<${name} tabs={${JSON.stringify(tabs)}}${c === 'dflt' ? '' : ` initial={${i}}`} />);`, `expect(screen.getByRole('tabpanel').textContent).toBe(${q(panel(i))});`] };
      },
      click(c) {
        const i = ri(1, tabs.length - 1);
        return { c: 'click' + (i % 3), async: true, name: `klik na ${tabs[i]}`, body: [`const user = userEvent.setup();`, `render(<${name} tabs={${JSON.stringify(tabs)}} />);`, `await user.click(screen.getByText(${q(tabs[i])}));`, `expect(screen.getByRole('tabpanel').textContent).toBe(${q(panel(i))});`] };
      },
      selected(c) {
        const i = ri(0, tabs.length - 1);
        return { c: 'sel' + (i % 3), name: `aria-selected u ${tabs[i]}`, body: [`render(<${name} tabs={${JSON.stringify(tabs)}} initial={${i}} />);`, `expect(screen.getAllByRole('tab')[${i}].getAttribute('aria-selected')).toBe('true');`] };
      },
    },
    hook() {
      return { name: 'výchozí karty', hook: [`render(<${name} tabs={${JSON.stringify(tabs)}} />);`], tests: [
        { name: `má ${tabs.length} karet`, body: [`expect(screen.getAllByRole('tab')).toHaveLength(${tabs.length});`] },
        { name: 'první je vybraná', body: [`expect(screen.getAllByRole('tab')[0].getAttribute('aria-selected')).toBe('true');`] },
        { name: 'přepnutí na druhou', body: [`fireEvent.click(screen.getAllByRole('tab')[1]);`, `expect(screen.getByRole('tabpanel').textContent).toBe(${q(panel(1))});`] },
      ] };
    },
    each() {
      return { title: 'karta %s', params: '(_t, i, expected)', rows: tabs.map((t, i) => `[${q(t)}, ${i}, ${q(panel(i))}]`),
        body: [`render(<${name} tabs={${JSON.stringify(tabs)}} initial={i as number} />);`, `expect(screen.getByRole('tabpanel').textContent).toBe(expected);`] };
    },
    journey: null,
  });
}

// ====== 9. Czech utils (non-ASCII source) + cart summary ==================================
{
  const SK = (n, t) => { const a = Math.abs(n); if (a === 1) return `${n} ${t[0]}`; if (a >= 2) { if (a <= 4) return `${n} ${t[1]}`; return `${n} ${t[2]}`; } return `${n} ${t[2]}`; };
  const KC = (x) => { const [c, d] = Math.abs(x).toFixed(2).split('.'); return `${x < 0 ? '−' : ''}${c.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${d} Kč`; };
  const POZ = (j, h) => (h < 10 ? `Dobré ráno, ${j}!` : h < 18 ? `Dobrý den, ${j}!` : `Dobrý večer, ${j}!`);
  const BEZ = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const TVARY = ['položka', 'položky', 'položek'];
  modules.push({
    name: 'cesky', group: 'cesky', file: 'utils/čeština.ts',
    render: ({ P, E }) => `/**
 * Pomocné funkce pro češtinu.
 * „Příliš žluťoučký kůň úpěl ďábelské ódy.“ – PŘÍLIŠ ŽLUŤOUČKÝ KŮŇ ÚPĚL ĎÁBELSKÉ ÓDY. 🐴🇨🇿
 * Skloňování: 1 položka, 2–4 položky, 0 a 5+ položek; měna: 1 234,50 Kč; pozdravy podle hodiny.
 * Ěščřžýáíéúů ťďň – tenhle komentář posouvá UTF-16 offsety vůči bajtům (UTF-8) o stovky míst.
 */
export type Tvary = [jednotné: string, dvaAzCtyri: string, mnohé: string];

export function sklonuj(počet: number, tvary: Tvary): string {
  ${P('skl')}
  const abs = Math.abs(počet);
  if (abs === 1) {
    ${P('one')}
    return \`\${počet} \${tvary[0]}\`;
  } else if (abs >= 2) {
    ${P('ge2')}
    if (abs <= 4) {
      ${P('few')}
      return \`\${počet} \${tvary[1]}\`;
    } else {
      ${P('many')}
      return \`\${počet} \${tvary[2]}\`;
    }
  } else {
    ${P('zero')}
    return \`\${počet} \${tvary[2]}\`;
  }
}

export function formátujKč(částka: number): string {
  ${P('kc')}
  const [celé, haléře] = Math.abs(částka).toFixed(2).split('.');
  const skupiny = celé.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ' ');
  const znaménko = částka < 0 ? ${E('neg', "'−'")} : ${E('pos', "''")};
  return \`\${znaménko}\${skupiny},\${haléře} Kč\`;
}

export function bezDiakritiky(text: string): string {
  ${P('bez')}
  return text.normalize('NFD').replace(/[\\u0300-\\u036f]/g, () => {
    ${P('strip')}
    return '';
  });
}

export function pozdrav(jméno: string, hodina: number): string {
  ${P('poz')}
  if (hodina < 10) {
    ${P('rano')}
    return \`Dobré ráno, \${jméno}!\`;
  } else if (hodina < 18) {
    ${P('den')}
    return \`Dobrý den, \${jméno}!\`;
  } else {
    ${P('vecer')}
    return \`Dobrý večer, \${jméno}!\`;
  }
}
`,
    imports: [`import { sklonuj, formátujKč, bezDiakritiky, pozdrav, type Tvary } from '../../src/utils/čeština';`],
    rtl: [],
    scen: {
      skl(c) {
        c ??= pick(['one', 'few', 'many', 'zero']); const n = c === 'one' ? pick([1, -1]) : c === 'few' ? ri(2, 4) : c === 'many' ? ri(5, 120) : 0;
        return { c: 's-' + c, name: `sklonuj(${n})`, body: [`const tvary: Tvary = ${JSON.stringify(TVARY)};`, `expect(sklonuj(${n}, tvary)).toBe(${q(SK(n, TVARY))});`] };
      },
      kc(c) {
        c ??= pick(['pos', 'neg']); const x = Math.round((c === 'neg' ? -1 : 1) * ri(0, 2000000)) / 100;
        return { c: 'k-' + c, name: `formátujKč(${x})`, body: [`expect(formátujKč(${x})).toBe(${q(KC(x))});`] };
      },
      bez(c) {
        c ??= pick(['dia', 'plain']); const s = c === 'dia' ? pick(CZ_NAMES) : pick(['Praha', 'Brno', 'Ostrava']);
        return { c: 'b-' + c, name: `bezDiakritiky(${q(s)})`, body: [`expect(bezDiakritiky(${q(s)})).toBe(${q(BEZ(s))});`] };
      },
      poz(c) {
        c ??= pick(['rano', 'den', 'vecer']); const h = c === 'rano' ? ri(0, 9) : c === 'den' ? ri(10, 17) : ri(18, 23); const j = pick(CZ_NAMES).split(' ')[0];
        return { c: 'p-' + c, name: `pozdrav v ${h} h`, body: [`expect(pozdrav(${q(j)}, ${h})).toBe(${q(POZ(j, h))});`] };
      },
    },
    hook: null,
    each() {
      const ns = shuffle([1, 2, 3, 4, 5, 11, 21, 0]);
      return { title: 'sklonuj %s', params: '(_l, n, expected)', rows: ns.map((n) => `[${q(String(n))}, ${n}, ${q(SK(n, TVARY))}]`),
        body: [`expect(sklonuj(n as number, ${JSON.stringify(TVARY)})).toBe(expected);`] };
    },
    journey: null,
  });
  // cart summary component using the utils
  const items = () => { const k = ri(0, 4); return Array.from({ length: k }, () => ({ název: pick(CZ_WORDS), cena: ri(100, 99999) / 100, ks: ri(1, 3) })); };
  const total = (its) => its.reduce((s, i) => s + i.cena * i.ks, 0);
  const count = (its) => its.reduce((s, i) => s + i.ks, 0);
  modules.push({
    name: 'KošíkSouhrn', group: 'cesky', file: 'components/KošíkSouhrn.tsx',
    render: ({ P }) => `import { formátujKč, sklonuj } from '../utils/čeština';

export interface Položka {
  název: string;
  cena: number;
  ks: number;
}

/** Souhrn košíku: „3 položky · 1 234,50 Kč“ */
export function KošíkSouhrn({ položky }: { položky: Položka[] }) {
  ${P('f')}
  const kusů = položky.reduce((s, p) => {
    ${P('ks')}
    return s + p.ks;
  }, 0);
  if (kusů === 0) {
    ${P('prazdny')}
    return <p className="košík">Košík je prázdný</p>;
  } else {
    ${P('plny')}
    const celkem = položky.reduce((s, p) => {
      ${P('sum')}
      return s + p.cena * p.ks;
    }, 0);
    return (
      <p className="košík">
        {sklonuj(kusů, ['položka', 'položky', 'položek'])} · {formátujKč(celkem)}
      </p>
    );
  }
}
`,
    imports: [`import { KošíkSouhrn } from '../../src/components/KošíkSouhrn';`],
    rtl: ['render', 'screen'],
    scen: {
      summary(c) {
        let its = items(); if (!its.length) its = [{ název: 'čočka', cena: 39.9, ks: 1 }];
        const txt = `${SK(count(its), TVARY)} · ${KC(total(its))}`;
        return { c: 'sum-' + (count(its) === 1 ? 'one' : count(its) <= 4 ? 'few' : 'many'), name: `souhrn ${txt}`, body: [`const { container } = render(<KošíkSouhrn položky={${JSON.stringify(its)}} />);`, `expect(container.textContent).toBe(${q(txt)});`] };
      },
      empty(c) {
        return { c: 'empty', name: 'prázdný košík', body: [`render(<KošíkSouhrn položky={[]} />);`, `expect(screen.getByText('Košík je prázdný')).toBeTruthy();`] };
      },
    },
    hook: null, each: null, journey: null,
  });
}

// ------------------------------------------------------------------ test file assembly
const planted = [];
const testFiles = []; // { path, code, tests: [{name(full), ...}] }
const TESTS_TARGET = 3000;
const tested = modules.filter((m) => !m.untested);
const fpmArg = args.indexOf('--files-per-module');
const filesPerModule = fpmArg >= 0 ? Number(args[fpmArg + 1]) : Math.round(300 / tested.length); // ~8 → ~300 files
const perFile = Math.round(TESTS_TARGET / (tested.length * filesPerModule));

function uniq(names, n) { let x = n, k = 2; while (names.has(x)) x = `${n} #${k++}`; names.add(x); return x; }
function emitTest(lines, ind, t) {
  lines.push(`${ind}it(${q(t.name)}, ${t.async ? 'async ' : ''}() => {`);
  for (const b of t.body) lines.push(`${ind}  ${b}`);
  lines.push(`${ind}});`);
}

for (const m of tested) {
  const scenNames = Object.keys(m.scen);
  const dir = m.group;
  const base = m.name.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const prevTests = []; // for cross-file twins: {file, full, scenKey, c}
  for (let fi = 0; fi < filesPerModule; fi++) {
    const rel = `test/${dir}/${base}.${fi + 1}.test.tsx`;
    const top = `${m.name} – sada ${fi + 1}`;
    const lines = [];
    const names = new Set();
    const local = [];
    let n = 0;
    const add = (ind, t, prefix, extra = {}) => {
      t.name = uniq(names, `${prefix ? prefix + ' > ' : ''}${t.name}`).slice(prefix ? prefix.length + 3 : 0);
      emitTest(lines, ind, t); n++;
      const full = `${top} > ${prefix ? prefix + ' > ' : ''}${t.name}`;
      local.push({ full, ...extra });
      return full;
    };
    lines.push(`import { describe, it, expect, beforeEach, vi } from 'vitest';`);
    const rtl = m.rtl.length ? [`import { ${[...m.rtl, 'cleanup'].join(', ')} } from '@testing-library/react';`] : [];
    lines.push(...rtl, ...m.imports, '');
    if (m.vi) lines.push(...m.vi, '');
    lines.push(`describe(${q(top)}, () => {`);
    if (m.pre) lines.push(...m.pre.map((l) => '  ' + l), '');
    // concurrent block in some files – must be serialized by the collector
    const concurrent = fi === 3 && !m.rtl.length; // RTL renders share one document → only pure-function suites
    // 1) planted twin pair (same branch class) – sometimes cross-file
    {
      const key = pick(scenNames);
      const a = m.scen[key]();
      const b = m.scen[key](a.c);
      const fa = add('  ', a, null);
      if (b.c === a.c) {
        b.name = b.name + ' (varianta)';
        if (fi > 0 && rnd() < 0.4 && prevTests.length) {
          // cross-file: re-create a twin of a test from an earlier file of this module
          const p = pick(prevTests);
          const t2 = m.scen[p.key](p.c);
          if (t2.c === p.c) { t2.name += ' (z jiného souboru)'; const f2 = add('  ', t2, null); planted.push({ kind: 'identical', note: 'cross-file twin', a: { file: p.file, name: p.full }, b: { file: rel, name: f2 } }); }
        }
        const fb = add('  ', b, null);
        planted.push({ kind: 'identical', note: `twin of scenario ${key}`, a: { file: rel, name: fa }, b: { file: rel, name: fb } });
      }
      prevTests.push({ file: rel, full: fa, key, c: a.c });
    }
    // 2) journey + subsumed part
    if (m.journey) {
      const j = m.journey();
      const ff = add('  ', j.full, null);
      const fp = add('  ', j.part, null);
      planted.push({ kind: 'subsumed', note: 'part of a journey test', a: { file: rel, name: fp }, b: { file: rel, name: ff } });
    }
    // 3) beforeEach-render describe
    if (m.hook && fi % 2 === 0) {
      const h = m.hook();
      lines.push('', `  describe(${q(h.name)}, () => {`, `    beforeEach(${h.async ? 'async ' : ''}() => {`, ...h.hook.map((l) => '      ' + l), '    });');
      const fulls = h.tests.map((t) => add('    ', t, h.name));
      lines.push('  });', '');
      planted.push({ kind: 'identical', note: 'beforeEach render, assertions only', a: { file: rel, name: fulls[0] }, b: { file: rel, name: fulls[1] } });
    }
    // 4) it.each
    if (m.each && fi % 2 === 1) {
      const e = m.each();
      lines.push(`  it.each([`, ...e.rows.map((r) => `    ${r},`), `  ])(${q(e.title)}, ${e.params} => {`, ...e.body.map((l) => '    ' + l), '  });');
      n += e.rows.length;
      for (const r of e.rows) local.push({ each: true });
    }
    // 5) random tests, some in a nested describe, optional concurrent group
    const rest = Math.max(2, perFile - n);
    const nestedAt = Math.floor(rest / 2);
    let inNested = false;
    for (let k = 0; k < rest; k++) {
      if (k === nestedAt) { lines.push('', `  describe${concurrent ? '.concurrent' : ''}(${q(concurrent ? 'souběžně' : 'další případy')}, () => {`); inNested = true; }
      let t = m.scen[pick(scenNames)]();
      if (rnd() < 0.35 && scenNames.length > 1) {
        // multi-step test: two scenarios in one test → more distinct coverage combinations
        const k2 = pick(scenNames); const t2 = m.scen[k2]();
        const sep = m.rtl.length ? ['cleanup();'] : [];
        if (m.vi) sep.push('vi.clearAllMocks();');
        t = { name: `${t.name} + ${t2.name}`, async: t.async || t2.async, body: ['{', ...t.body.map((l) => '  ' + l), '}', ...sep, '{', ...t2.body.map((l) => '  ' + l), '}'] };
      }
      if (concurrent && inNested) { t.async = true; t.body = [`await new Promise((r) => setTimeout(r, ${ri(1, 4)}));`, ...t.body]; }
      add(inNested ? '    ' : '  ', t, inNested ? (concurrent ? 'souběžně' : 'další případy') : null);
    }
    if (inNested) lines.push('  });');
    lines.push('});', '');
    testFiles.push({ path: rel, code: lines.join('\n'), count: n });
  }
}

// ------------------------------------------------------------------ write project
for (const d of ['src', 'test', '.vto-probe']) rmSync(path.join(target, d), { recursive: true, force: true });
const w = (rel, code) => { const f = path.join(target, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, code); };
for (const m of modules) {
  w(`src/${m.file}`, m.render(probes(m.name, false)));
  w(`.vto-probe/src/${m.file}`, m.render(probes(m.name, true)));
}
for (const t of testFiles) w(t.path, t.code);
w('test/setup.ts', `// user setup file: RTL cleanup after each test (unmount → effect cleanups run in afterEach)
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
`);
w('vitest.config.ts', `import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.tsx'],
    setupFiles: ['./test/setup.ts'],
    coverage: { provider: 'v8', include: ['src/**'] },
  },
});
`);
w('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx', strict: true, noEmit: true, skipLibCheck: true, types: ['vitest/globals'] }, include: ['src', 'test'] }, null, 2) + '\n');
w('.gitignore', 'node_modules\noverlap-report\n.vto/\n.vto-tmp/\nverify-report/\n');
// probe (ground truth) config
w('.vto-probe/setup.ts', `import { beforeEach, afterAll } from 'vitest';
import { appendFileSync } from 'node:fs';
const G = globalThis as any;
const hits = new Set<string>();
G.__probe = (id: string) => { hits.add(id); };
G.__probeAnd = (id: string, v: unknown) => { if (!v) hits.add(id); return v; };
const recs: string[] = [];
const realImmediate = setImmediate;
beforeEach((ctx) => {
  hits.clear();
  ctx.onTestFinished(async () => {
    await new Promise((r) => realImmediate(r));
    const t = ctx.task as any;
    recs.push(JSON.stringify({ file: t.file.filepath, name: t.fullTestName, line: t.location?.line ?? null, state: t.result?.state, probes: [...hits].sort() }));
  });
});
afterAll(() => { if (recs.length) appendFileSync(process.env.VTO_PROBE_OUT!, recs.join('\\n') + '\\n'); recs.length = 0; });
`);
w('.vto-probe/vitest.config.ts', `import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
export default defineConfig({
  root,
  plugins: [
    {
      name: 'probe-sources',
      enforce: 'pre',
      load(id) {
        const file = id.split('?')[0];
        if (file.startsWith(root + '/src/')) return readFileSync(root + '/.vto-probe/src/' + file.slice(root.length + 5), 'utf8');
      },
    },
    react(),
  ],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.tsx'],
    setupFiles: ['./.vto-probe/setup.ts', './test/setup.ts'],
    fsModuleCache: false,
  },
});
`);

const totalTests = testFiles.reduce((s, f) => s + f.count, 0);
console.log(`generated ${modules.length} modules, ${testFiles.length} test files, ${totalTests} tests, ${planted.length} planted relations → ${target}`);
if (!verify) process.exit(0);

// ------------------------------------------------------------------ ground truth via probe run
const probeOut = path.join(target, '.vto-probe', 'probes.jsonl');
rmSync(probeOut, { force: true });
console.log('running probe build (ground truth)…');
const r = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', '.vto-probe/vitest.config.ts', '--reporter=dot'], { cwd: target, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 28, env: { ...process.env, VTO_PROBE_OUT: probeOut } });
if (r.error) console.error(r.error);
const outTxt = r.stdout.toString();
console.log(outTxt.split('\n').filter((l) => /Test Files|Tests|FAIL|Error/.test(l)).slice(0, 30).join('\n'));
if (r.status !== 0) { console.error('probe run failed – fixture tests must all pass'); process.exit(1); }
const recs = readFileSync(probeOut, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const rel = (f) => path.relative(target, f);
const key = (file, name) => `${file}\u0000${name}`;
const byKey = new Map(recs.map((x) => [key(rel(x.file), x.name), x]));
if (byKey.size !== recs.length) console.warn(`warning: ${recs.length - byKey.size} duplicate test ids`);
const sig = (x) => x.probes.join('|');

// identical groups
const groups = new Map();
for (const x of recs) if (x.probes.length) { const s = sig(x); if (!groups.has(s)) groups.set(s, []); groups.get(s).push(x); }
const identicalGroups = [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
// strict containment over unique signatures (bitsets)
const atomIdx = new Map();
for (const x of recs) for (const p of x.probes) if (!atomIdx.has(p)) atomIdx.set(p, atomIdx.size);
const uniq2 = [...groups.entries()].map(([s, g]) => { let b = 0n; for (const p of g[0].probes) b |= 1n << BigInt(atomIdx.get(p)); return { s, g, b, n: g[0].probes.length }; });
const supers = new Map();
for (const u of uniq2) for (const v of uniq2) if (v.n > u.n && (u.b & v.b) === u.b) { if (!supers.has(u)) supers.set(u, []); supers.get(u).push(v); }
const subsumed = [];
for (const [u, vs] of supers) for (const t of u.g) subsumed.push({ test: { file: rel(t.file), name: t.name, line: t.line }, byCount: vs.reduce((s, v) => s + v.g.length, 0), examples: vs.sort((a, b) => a.n - b.n).slice(0, 3).map((v) => ({ file: rel(v.g[0].file), name: v.g[0].name })) });
// verify planted
let ok = 0;
for (const p of planted) {
  const a = byKey.get(key(p.a.file, p.a.name)), b = byKey.get(key(p.b.file, p.b.name));
  if (!a || !b) { p.verified = false; p.reason = 'test not found in probe run'; continue; }
  const sa = new Set(a.probes), sb = new Set(b.probes);
  const aInB = [...sa].every((x) => sb.has(x)), bInA = [...sb].every((x) => sa.has(x));
  p.actual = aInB && bInA ? 'identical' : aInB ? 'subsumed' : bInA ? 'contains' : 'overlap';
  p.verified = p.actual === p.kind;
  if (p.verified) ok++;
}
const atomsTotal = atomIdx.size;
const expected = {
  generatedBy: 'vto/bench/gen-project.mjs', seed, modules: modules.length, testFiles: testFiles.length, tests: recs.length,
  note: 'Ground truth from explicit probes (.vto-probe/src, one probe per function entry / branch arm / && short-circuit – the same ' +
    'branch points vto v2 instruments). Equality and strict containment of probe sets are expected to match v2 atom sets. ' +
    'Test ids: file (relative to the project root) + name (describe chain joined by " > ").',
  probeAtoms: atomsTotal,
  planted: { total: planted.length, verified: ok, items: planted },
  identicalGroups: identicalGroups.map((g) => g.map((x) => ({ file: rel(x.file), name: x.name, line: x.line }))),
  identicalTests: identicalGroups.reduce((s, g) => s + g.length, 0),
  subsumedCount: subsumed.length,
  subsumed,
  noCoverage: recs.filter((x) => !x.probes.length).map((x) => ({ file: rel(x.file), name: x.name })),
};
writeFileSync(path.join(target, 'EXPECTED.json'), JSON.stringify(expected, null, 1) + '\n');
console.log(`EXPECTED.json: ${recs.length} tests, ${identicalGroups.length} identical groups (${expected.identicalTests} tests), ${subsumed.length} strictly subsumed, planted ${ok}/${planted.length} verified`);
const bad = planted.filter((p) => !p.verified);
if (bad.length) console.log('unverified planted:', JSON.stringify(bad.slice(0, 5), null, 1));
