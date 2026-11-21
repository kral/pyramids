// vto env probe (setupFile, appended after the user's setup files by the daemon).
// Records whether a test file touched DOM globals at all → `suggest_env` can propose
// `environment: 'node'` for files that never did. Getter traps on the DOM globals of the test
// environment; the first access marks the file and restores the original descriptors, so the
// cost after that is zero. Accesses during the user's setup files are ignored (traps are
// installed after them) – a setup that needs the DOM for every file is a config concern. DOM writes
// through references captured earlier are caught by a MutationObserver on the document.
import { afterAll } from 'vitest';
import { appendFileSync } from 'node:fs';
import { threadId } from 'node:worker_threads';

const G = globalThis;
const KEYS = ['document', 'window', 'navigator', 'location', 'localStorage', 'sessionStorage', 'HTMLElement', 'Element', 'Node',
  'Event', 'getComputedStyle', 'requestAnimationFrame', 'MutationObserver', 'customElements', 'DOMParser'];
const saved = [];
let touched = false;
const env = G.__vitest_worker__?.environment?.name ?? G.__vitest_worker__?.ctx?.environment?.name ?? null;
const restore = () => { for (const [k, d] of saved) { try { Object.defineProperty(G, k, d); } catch {} } saved.length = 0; };
if (typeof G.document !== 'undefined') {
  // writes through references captured before this probe (e.g. RTL's `screen` / document.body taken
  // when the user's setup file imported it) bypass the global traps: a MutationObserver catches every
  // render into the document
  try {
    const mo = new G.MutationObserver(() => { touched = true; mo.disconnect(); });
    mo.observe(G.document, { subtree: true, childList: true, attributes: true, characterData: true });
  } catch {}
  for (const k of KEYS) {
    const d = Object.getOwnPropertyDescriptor(G, k);
    if (!d || !d.configurable) continue;
    saved.push([k, d]);
    Object.defineProperty(G, k, {
      configurable: true, enumerable: d.enumerable,
      get() { touched = true; restore(); return d.get ? d.get.call(G) : d.value; },
      set(v) { touched = true; restore(); G[k] = v; },
    });
  }
}
afterAll(() => {
  restore();
  const dir = process.env.VTO_RAW_DIR;
  let testFile = null;
  try { testFile = (G[Symbol.for('expect-global')]).getState().testPath ?? null; } catch {}
  if (!dir || !testFile) return;
  appendFileSync(`${dir}/env-${process.pid}-${threadId}.jsonl`, JSON.stringify({ t: 'env', testFile, env, dom: typeof G.document === 'undefined' ? null : touched }) + '\n', { mode: 0o600 });
});
