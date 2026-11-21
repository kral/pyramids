// Snapshot tests of rendered frames (ink-testing-library, 100 columns, colours off) and
// keyboard interaction tests on the App.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import React from 'react';
import path from 'node:path';
import { render, cleanup } from 'ink-testing-library';
import { App } from '../src/ui/App.js';
import { RunStore } from '../src/model.js';
import { normalizeEvent, type VtoEvent } from '../src/events.js';
import { MockSource } from '../src/mock/source.js';
import { DEFAULT_MOCK } from '../src/mock/scenario.js';
import { initTerm } from '../src/term.js';
import { setLocale } from '../src/i18n.js';
import { fakeActions, KEYS, renderApp } from './harness.js';

const ROOT = path.resolve(__dirname, '../dev/fixture');
const NOW = 1_700_000_000_000;

beforeAll(() => { initTerm({ colorLevel: 0, unicode: true, sgr: false }); setLocale('cs'); });
afterEach(() => cleanup());

function scenario(frac: number, opts: Partial<typeof DEFAULT_MOCK> = {}) {
  const src = new MockSource({ ...DEFAULT_MOCK, root: ROOT, ...opts });
  const store = new RunStore({ now: () => NOW });
  const tl = src.timeline;
  const cut = frac * tl.at(-1)!.at;
  const due = tl.filter((x) => x.at <= cut).map((x) => normalizeEvent(x.ev)).filter((e): e is VtoEvent => !!e);
  store.applyMany(due);
  const rest = tl.filter((x) => x.at > cut).map((x) => normalizeEvent(x.ev)).filter((e): e is VtoEvent => !!e);
  return { src, store, rest };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
const frame = (f: string | undefined) => (f ?? '').split('\n').map((l) => l.trimEnd()).join('\n');

function mount(store: RunStore, src: MockSource, size = { columns: 100, rows: 30 }, actions = fakeActions()) {
  if (size.columns > 100) {
    // ink-testing-library's stdout is fixed at 100 columns → use the sized harness for wide frames
    const h = renderApp({ store, source: src, root: ROOT, actions, columns: size.columns, rows: size.rows, staticClock: NOW });
    return { lastFrame: h.lastFrame, stdin: h.stdin, actions, press: async (k: string) => { await h.press(k); } };
  }
  const r = render(<App store={store} source={src} root={ROOT} actions={actions} staticClock={NOW} batchMs={0} size={size} />);
  return { ...r, actions, press: async (k: string) => { r.stdin.write(k); await tick(); } };
}

describe('frames (snapshots)', () => {
  it('waiting for the first event', () => {
    const src = new MockSource({ ...DEFAULT_MOCK, root: ROOT });
    const { lastFrame } = mount(new RunStore(), src, { columns: 100, rows: 12 });
    expect(frame(lastFrame())).toMatchSnapshot();
  });

  it('run in progress with failures (wide layout, 120 cols)', () => {
    const { store, src } = scenario(0.55);
    const { lastFrame } = mount(store, src, { columns: 120, rows: 32 });
    expect(frame(lastFrame())).toMatchSnapshot();
  });

  it('narrow layout (80x24), stacked panes', () => {
    const { store, src } = scenario(0.55);
    const { lastFrame } = mount(store, src, { columns: 80, rows: 24 });
    expect(frame(lastFrame())).toMatchSnapshot();
  });

  it('details zoomed for a grouped failure (Enter expands, Enter on member zooms)', async () => {
    const { store, src } = scenario(1);
    const m = mount(store, src);
    // move to the UserList group (several tests with the same error)
    const rows = () => frame(m.lastFrame());
    for (let i = 0; i < 10 && !/❯ ✗ ▸ TypeError/.test(rows()); i++) await m.press(KEYS.down);
    expect(rows()).toMatch(/❯ ✗ ▸ TypeError: Cannot read properties of undefined/);
    await m.press(KEYS.enter); // expand
    expect(rows()).toMatch(/▾ TypeError/);
    await m.press(KEYS.down); // first member
    await m.press(KEYS.enter); // zoom details
    expect(rows()).toMatchSnapshot();
  });

  it('fixed during run + finished state', () => {
    const { store, src } = scenario(1);
    const { lastFrame } = mount(store, src, { columns: 120, rows: 30 });
    const f = frame(lastFrame());
    expect(f).toContain('opraveno během běhu');
    expect(f).toContain('dokončeno');
    expect(f).toMatchSnapshot();
  });

  it('help overlay', async () => {
    const { store, src } = scenario(0.3);
    const m = mount(store, src, { columns: 100, rows: 24 });
    await m.press('?');
    expect(frame(m.lastFrame())).toMatchSnapshot();
    await m.press('x');
    expect(frame(m.lastFrame())).not.toContain('Nápověda');
  });

  it('ASCII fallback (no Unicode)', () => {
    initTerm({ colorLevel: 0, unicode: false, sgr: false });
    try {
      const { store, src } = scenario(0.55);
      const { lastFrame } = mount(store, src, { columns: 100, rows: 20 });
      const f = frame(lastFrame());
      expect(f).not.toMatch(/[╭│█✗✔]/);
      expect(f).toMatchSnapshot();
    } finally { initTerm({ colorLevel: 0, unicode: true, sgr: false }); }
  });

  it('English locale', () => {
    setLocale('en');
    try {
      const { store, src } = scenario(1);
      const f = frame(mount(store, src, { columns: 120, rows: 20 }).lastFrame());
      expect(f).toContain('fixed during run');
      expect(f).toContain('Failures');
    } finally { setLocale('cs'); }
  });
});

describe('interaction', () => {
  it('selection does not jump while new failures stream in', async () => {
    const { store, src, rest } = scenario(0.5);
    const m = mount(store, src);
    await m.press(KEYS.down);
    const selected = () => frame(m.lastFrame()).split('\n').find((l) => l.includes('❯ '))!.replace(/[│╭╮╰╯─]/g, '').trim().slice(0, 40);
    const before = selected();
    for (let i = 0; i < rest.length; i += 25) { store.applyMany(rest.slice(i, i + 25)); await tick(); }
    expect(selected()).toBe(before);
  });

  it('o / O open the project frame and the failing test line', async () => {
    const { store, src } = scenario(0.3);
    const m = mount(store, src);
    await m.press('o');
    await m.press('O');
    expect(m.actions.log).toEqual(['open src/utils/format.ts:3:17', 'open src/utils/format.test.ts:6:5']);
    expect(frame(m.lastFrame())).toContain('Otevírám src/utils/format.test.ts:6 v fake-editor');
  });

  it('o without an editor shows the path and copies it (never an OS opener, S-N4)', async () => {
    const { store, src } = scenario(1);
    let copied = '';
    const err = Object.assign(new Error('no-editor'), { location: '/proj/src/utils/format.ts:6' });
    const actions = { ...fakeActions(), openEditor: async () => { throw err; }, copy: async (t: string) => { copied = t; return 'test'; } };
    const m = mount(store, src, { columns: 140, rows: 30 }, actions);
    await m.press('o');
    expect(copied).toBe('/proj/src/utils/format.ts:6');
    expect(frame(m.lastFrame())).toContain('/proj/src/utils/format.ts:6');
  });

  it('c copies an AI-ready prompt for the selected group', async () => {
    const { store, src } = scenario(1);
    let copied = '';
    const actions = { ...fakeActions(), copy: async (t: string) => { copied = t; return 'test'; } };
    const m = mount(store, src, undefined, actions);
    for (let i = 0; i < 10 && !/❯ ✗ ▸ TypeError/.test(frame(m.lastFrame())); i++) await m.press(KEYS.down);
    await m.press('c');
    expect(copied).toMatch(/selhává \d+ testů se stejnou chybou/);
    expect(copied).toContain("TypeError: Cannot read properties of undefined (reading 'map')");
    expect(copied).toContain('src/components/UserList.tsx:12:13');
    expect(copied).toContain('{users.map((u) => (');
    expect(copied).toContain('run_tests');
    expect(frame(m.lastFrame())).toContain('Prompt zkopírován do schránky (test)');
  });

  it('r reruns the selected group, R all failed; results turn green inline', async () => {
    const { store, src } = scenario(1, { seed: 7 });
    const s2 = new MockSource({ ...DEFAULT_MOCK, root: ROOT, rerunPassRate: 1, speed: 50 });
    // share the store state with the request simulator
    s2.start({ onEvents: (evs) => store.applyMany(evs) });
    s2.drain();
    const m = mount(store, s2);
    await m.press(KEYS.down);
    await m.press('r');
    expect(s2.requests[0]).toMatchObject({ method: 'rerun_failed', params: { runId: 'r12', ids: [expect.any(String)] } });
    expect(frame(m.lastFrame())).toMatch(/spouštím znovu…|Znovu spouštím/);
    expect(frame(m.lastFrame())).toContain('jako běh r13'); // daemon answered with a new run id
    await m.press('R');
    expect(s2.requests[1]).toEqual({ method: 'rerun_failed', params: { runId: 'r12' } });
    await new Promise((r) => setTimeout(r, 120));
    await tick();
    const f = frame(m.lastFrame());
    expect(f).toContain('opraveno během běhu');
    expect(store.current!.failures.size).toBeGreaterThan(0);
    expect([...store.current!.failures.values()].every((x) => x.fix === 'fixed')).toBe(true);
    void src;
  });

  it('a enqueues the group as an MCP task', async () => {
    const { store, src } = scenario(1);
    const m = mount(store, src);
    await m.press('a'); // first row is already fixed → nothing to queue
    expect(src.requests).toHaveLength(0);
    await m.press(KEYS.down);
    await m.press('a');
    expect(src.requests[0]).toMatchObject({ method: 'enqueue_task', params: { task: { runId: 'r12', count: expect.any(Number), ids: expect.any(Array) } } });
    expect(frame(m.lastFrame())).toContain('zařazena do fronty MCP');
  });

  it('f cycles filters, / searches (diacritics-insensitive), Esc clears', async () => {
    const { store, src } = scenario(1);
    const m = mount(store, src);
    await m.press('f'); // failed
    expect(frame(m.lastFrame())).toContain('filtr: selhané');
    expect(frame(m.lastFrame())).not.toContain('formatPrice > formats thousands');
    await m.press('f'); // fixed
    expect(frame(m.lastFrame())).toContain('formatPrice > formats thousands');
    await m.press('f'); // all
    await m.press('/');
    for (const ch of 'nacitani') await m.press(ch);
    expect(frame(m.lastFrame())).toContain('Hledat: nacitani');
    await m.press(KEYS.enter);
    const f = frame(m.lastFrame());
    expect(f).toContain('filtr: vše "nacitani"');
    await m.press(KEYS.esc);
    expect(frame(m.lastFrame())).not.toContain('"nacitani"');
  });

  it('a falls back to copying the task JSON when the daemon has no task queue', async () => {
    const { store, src } = scenario(1);
    let copied = '';
    const actions = { ...fakeActions(), copy: async (t: string) => { copied = t; return 'test'; } };
    const noQueue = { label: 'daemon', canRequest: true, start() {}, close() {}, request: () => Promise.reject(Object.assign(new Error('unknown method enqueue_task'), { code: 'E_METHOD' })) };
    const m = mount(store, noQueue as any, undefined, actions);
    await m.press(KEYS.down);
    await m.press('a');
    await tick();
    expect(JSON.parse(copied)).toMatchObject({ runId: 'r12', ids: expect.any(Array), group: expect.any(String) });
    expect(frame(m.lastFrame())).toContain('nemá frontu úloh');
    void src;
  });

  it('read-only sources explain why r/a do nothing', async () => {
    const { store } = scenario(1);
    const ro = { label: 'soubor x.jsonl', canRequest: false, start() {}, close() {}, request: () => Promise.reject(new Error('ro')) };
    const r = render(<App store={store} source={ro} root={ROOT} actions={fakeActions()} staticClock={NOW} batchMs={0} size={{ columns: 120, rows: 30 }} />);
    r.stdin.write('r'); await tick();
    expect(frame(r.lastFrame())).toContain('jen pro čtení');
  });
});
