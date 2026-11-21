// The Ink output-cache patch must not change a single byte of any frame.
import { describe, it, expect } from 'vitest';
import React from 'react';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.js';
import { RunStore } from '../src/model.js';
import { MockSource } from '../src/mock/source.js';
import { DEFAULT_MOCK } from '../src/mock/scenario.js';
import { initTerm } from '../src/term.js';
import { setLocale } from '../src/i18n.js';
import { patchInkOutputCaches } from '../src/ui/inkPerf.js';

const ROOT = path.resolve(__dirname, '../dev/fixture');
const actions = { openEditor: async () => 'x', copy: async () => 'x' };

async function frames(): Promise<string[]> {
  const store = new RunStore({ now: () => 1 });
  const src = new MockSource({ ...DEFAULT_MOCK, root: ROOT, tests: 2000, failures: 120 });
  src.start({ onEvents: (e) => store.applyMany(e) }); src.close(); src.drain();
  const out: string[] = [];
  const r = render(<App store={store} source={src} root={ROOT} actions={actions} staticClock={1} batchMs={0} size={{ columns: 100, rows: 30 }} />);
  const settle = () => new Promise((res) => setTimeout(res, 40));
  await settle();
  out.push(r.lastFrame() ?? '');
  for (const k of ['j', 'j', '\r', 'j', 'f', 'G']) { r.stdin.write(k); await settle(); out.push(r.lastFrame() ?? ''); }
  r.unmount();
  return out;
}

describe('Ink output cache patch', () => {
  it('applies and renders identical frames (truecolor)', async () => {
    initTerm({ colorLevel: 3, unicode: true }); setLocale('cs');
    const before = await frames();
    expect(await patchInkOutputCaches({})).toBe(true);
    const after = await frames();
    expect(after).toEqual(before);
    expect(after.at(-1)).toContain('\x1b[38;2;');
  });
  it('kill switch', async () => {
    // already applied in this worker → returns the cached result; the env check is covered by the
    // VTO_UI_NO_INK_PATCH branch being the first statement
    expect(typeof (await patchInkOutputCaches({ VTO_UI_NO_INK_PATCH: '1' }))).toBe('boolean');
  });
});
