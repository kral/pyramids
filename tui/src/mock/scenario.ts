// Deterministic, realistic mock run (schema of MCP.md "Live streaming of failures").
// Failures point at real files in dev/fixture so code frames are read from disk like in a real
// project. Used by the in-process MockSource, the mock IPC daemon and `--write` (jsonl).
import fs from 'node:fs';
import path from 'node:path';

export interface MockOptions {
  runId: string;
  kind: 'affected' | 'full' | 'tests';
  pool: string;
  tests: number;
  files: number;
  failures: number;
  durationMs: number;
  seed: number;
  /** failures that get a simulated "saved a fix" fix-rerun during the run */
  fixDuringRun: number;
  /** include the optional run-start.projects extension */
  projectTotals: boolean;
  /** fixture root (code frames); line numbers are looked up in these files */
  root: string;
  workers: number;
}

export interface Timed { at: number; ev: Record<string, unknown> }

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Template {
  group: string;
  testFile: string;
  describe: string;
  name: string;
  /** substring locating the test's `it(` line */
  findTest: string;
  /** substring locating the assertion line in the test file */
  findAssert: string;
  message: string;
  diff?: string;
  /** project frames (source file + substring) */
  frames: Array<{ file: string; find: string; colOf?: string }>;
  coveredChanged?: boolean;
  /** relative weight when distributing many failures */
  weight: number;
}

const TEMPLATES: Template[] = [
  {
    group: 'g-7a1c', testFile: 'src/components/UserList.test.tsx', describe: 'UserList', name: 'renders empty state while loading',
    findTest: "it('renders empty state", findAssert: 'render(<UserList onSelect',
    message: "TypeError: Cannot read properties of undefined (reading 'map')",
    frames: [{ file: 'src/components/UserList.tsx', find: 'users.map(', colOf: '.map' }], coveredChanged: true, weight: 5,
  },
  {
    group: 'g-31f0', testFile: 'src/utils/format.test.ts', describe: 'formatPrice', name: 'formats thousands with a space and decimal comma',
    findTest: "it('formats thousands", findAssert: 'expect(formatPrice(1234.5))',
    message: "AssertionError: expected '1234.50 Kč' to be '1 234,50 Kč' // Object.is equality",
    diff: '- Expected\n+ Received\n\n- 1 234,50 Kč\n+ 1234.50 Kč',
    frames: [{ file: 'src/utils/format.ts', find: 'value.toFixed(2)', colOf: 'value' }], coveredChanged: true, weight: 2,
  },
  {
    group: 'g-b812', testFile: 'src/components/Button.test.tsx', describe: 'Button', name: 'disabled',
    findTest: "it('disabled'", findAssert: 'toHaveBeenCalledTimes(0)',
    message: 'AssertionError: expected "spy" to be called 0 times, but got 1 times',
    diff: '- Expected\n+ Received\n\n- 0\n+ 1',
    frames: [{ file: 'src/components/Button.tsx', find: 'onClick?.()', colOf: 'onClick' }], coveredChanged: true, weight: 2,
  },
  {
    group: 'g-0c9d', testFile: 'src/hooks/useCart.test.ts', describe: 'useCart', name: 'computes totals with quantity',
    findTest: "it('computes totals", findAssert: 'toEqual({ subtotal: 200',
    message: 'AssertionError: expected { subtotal: 100, vat: 21, …(2) } to deeply equal { subtotal: 200, vat: 42, …(2) }',
    diff: '- Expected\n+ Received\n\n  {\n-   "count": 2,\n-   "subtotal": 200,\n-   "total": 242,\n-   "vat": 42,\n+   "count": 1,\n+   "subtotal": 100,\n+   "total": 121,\n+   "vat": 21,\n  }',
    frames: [{ file: 'src/hooks/useCart.ts', find: 's + i.price', colOf: 's + i.price' }], weight: 2,
  },
  {
    group: 'g-e44a', testFile: 'src/api/client.test.ts', describe: 'retry', name: 'gives up after 3 attempts',
    findTest: "it('gives up", findAssert: 'rejects.toThrow',
    message: 'Error: Test timed out in 5000ms.\nIf this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".',
    frames: [{ file: 'src/api/client.ts', find: 'setTimeout(r, 2000 * i)', colOf: 'setTimeout' }], weight: 1,
  },
  {
    group: 'g-5d27', testFile: 'src/utils/format.test.ts', describe: 'formatDate', name: 'formats Czech date',
    findTest: "it('formats Czech date", findAssert: "toBe('21. 11. 2026')",
    message: "AssertionError: expected '21.\u00a011.\u00a02026' to be '21. 11. 2026' // Object.is equality",
    diff: '- Expected\n+ Received\n\n- 21. 11. 2026\n+ 21.\u00a011.\u00a02026',
    frames: [{ file: 'src/utils/format.ts', find: "toLocaleDateString('cs-CZ'", colOf: 'toLocaleDateString' }], weight: 1,
  },
];

const SYNTH_MESSAGES = [
  (n: number) => `AssertionError: expected 'Načítání…' to be 'Hotovo' (varianta ${n})`,
  (n: number) => `TestingLibraryElementError: Unable to find an element with the text: Uložit změny ${n}`,
  (n: number) => `AssertionError: expected [ 'a', 'b' ] to have a length of ${n + 3} but got 2`,
  (n: number) => `Error: [vitest] No "default" export is defined on the "./i18n-${n}" mock`,
];

const findCache = new Map<string, string[]>();
function lineOf(root: string, file: string, needle: string): { line: number; col: number; code: string } {
  let lines = findCache.get(path.join(root, file));
  if (!lines) {
    try { lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/); } catch { lines = []; }
    findCache.set(path.join(root, file), lines);
  }
  const i = lines.findIndex((l) => l.includes(needle));
  if (i < 0) return { line: 1, col: 1, code: '' };
  return { line: i + 1, col: lines[i].indexOf(needle) + 1, code: lines[i] };
}

export const DEFAULT_MOCK: MockOptions = {
  runId: 'r12', kind: 'affected', pool: 'vmThreads', tests: 412, files: 38, failures: 7, durationMs: 20_000, seed: 7,
  fixDuringRun: 1, projectTotals: true, root: '', workers: 4,
};

const SYNTH_DIRS = ['components', 'features/cart', 'features/checkout', 'features/profile', 'hooks', 'utils', 'pages', 'api'];
const SYNTH_NAMES = ['Header', 'Footer', 'ProductCard', 'Checkout', 'Profile', 'Avatar', 'Modal', 'Tabs', 'Table', 'Form', 'DatePicker', 'Toast', 'Menu', 'Search'];

export function buildScenario(o: MockOptions): Timed[] {
  const rnd = mulberry32(o.seed);
  const root = o.root;
  const fixtureFiles = [...new Set(TEMPLATES.map((t) => t.testFile))];
  const files: string[] = [...fixtureFiles];
  for (let i = 0; files.length < Math.max(o.files, fixtureFiles.length); i++) {
    const dir = SYNTH_DIRS[i % SYNTH_DIRS.length];
    const name = SYNTH_NAMES[i % SYNTH_NAMES.length] + (i >= SYNTH_NAMES.length ? Math.floor(i / SYNTH_NAMES.length) : '');
    files.push(`src/${dir}/${name}.test.${i % 3 === 2 ? 'ts' : 'tsx'}`);
  }
  const projectOf = (f: string) => (f.endsWith('.tsx') ? 'dom' : 'node');

  // --- choose failures: first one per template, then weighted repeats + synthetic groups
  type Fail = { tpl: Template | null; group: string; message: string; testFile: string; name: string; describe: string; synth?: number };
  const fails: Fail[] = [];
  for (const tpl of TEMPLATES) if (fails.length < o.failures) fails.push({ tpl, group: tpl.group, message: tpl.message, testFile: tpl.testFile, name: tpl.name, describe: tpl.describe });
  const totalW = TEMPLATES.reduce((s, t) => s + t.weight, 0);
  let synthGroups = 0;
  while (fails.length < o.failures) {
    const k = fails.length;
    if (o.failures > 12 && rnd() < 0.25) { // a new distinct group (only in large runs)
      const n = synthGroups++;
      const tpl = TEMPLATES[n % TEMPLATES.length];
      fails.push({ tpl, group: `g-s${n.toString(16)}`, message: SYNTH_MESSAGES[n % SYNTH_MESSAGES.length](n), testFile: tpl.testFile, name: `scenario ${k}`, describe: tpl.describe, synth: n });
    } else { // same error in yet another test (grouped)
      let r = rnd() * totalW, tpl = TEMPLATES[0];
      for (const t of TEMPLATES) { r -= t.weight; if (r <= 0) { tpl = t; break; } }
      fails.push({ tpl, group: tpl.group, message: tpl.message, testFile: tpl.testFile, name: `${tpl.name} (case ${k})`, describe: tpl.describe });
    }
  }

  // --- distribute tests over files (fixture files get the failing ones)
  const perFile = new Map<string, Array<{ id: string; fail?: Fail; line: number }>>();
  for (const f of files) perFile.set(f, []);
  const failByFile = new Map<string, Fail[]>();
  for (const f of fails) { const a = failByFile.get(f.testFile) ?? []; a.push(f); failByFile.set(f.testFile, a); }
  for (const [file, fs_] of failByFile) {
    for (const f of fs_) {
      const loc = lineOf(root, file, f.tpl?.findTest ?? 'it(');
      perFile.get(file)!.push({ id: `${file}:${loc.line} > ${f.describe} > ${f.name}`, fail: f, line: loc.line });
    }
  }
  let assigned = fails.length;
  let fi = 0;
  while (assigned < o.tests) {
    const file = files[fi % files.length];
    const arr = perFile.get(file)!;
    const line = 10 + arr.length * 7;
    const base = path.posix.basename(file).replace(/\.test\.tsx?$/, '');
    arr.push({ id: `${file}:${line} > ${base} > ${['renders', 'handles click', 'shows error', 'updates on change', 'matches a11y rules', 'loads data'][arr.length % 6]} ${arr.length + 1}`, line });
    assigned++; fi++;
  }
  // shuffle tests within each file so failures are spread over time
  for (const arr of perFile.values()) {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  }
  // shuffle file order (keep it deterministic)
  const order = [...files];
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }

  // --- simulate workers
  const raw: Timed[] = [];
  const clocks = new Array(Math.max(1, o.workers)).fill(0);
  let seq = 0;
  for (const file of order) {
    const tests = perFile.get(file)!;
    if (!tests.length) continue;
    let w = 0;
    for (let i = 1; i < clocks.length; i++) if (clocks[i] < clocks[w]) w = i;
    let t = clocks[w] + 40 + rnd() * 120; // module load
    raw.push({ at: t, ev: { ev: 'file-start', runId: o.runId, file, project: projectOf(file) } });
    for (const tc of tests) {
      const ms = Math.round(2 + -Math.log(1 - rnd()) * 25 + (tc.fail?.tpl?.group === 'g-e44a' ? 5000 : 0));
      t += ms;
      raw.push({ at: t, ev: { ev: 'test', runId: o.runId, id: tc.id, state: tc.fail ? 'fail' : rnd() < 0.01 ? 'skip' : 'pass', ms } });
      if (tc.fail) {
        const f = tc.fail;
        const tpl = f.tpl!;
        const assert = lineOf(root, f.testFile, tpl.findAssert);
        const frames = [
          ...tpl.frames.map((fr) => { const l = lineOf(root, fr.file, fr.find); const col = fr.colOf ? l.code.indexOf(fr.colOf) + 1 : l.col; return { file: fr.file, line: l.line, col, code: l.code.trim() }; }),
          { file: f.testFile, line: assert.line, col: assert.col, code: assert.code.trim() },
        ];
        raw.push({
          at: t + 0.01,
          ev: {
            ev: 'failure', runId: o.runId, seq: 0, id: tc.id, file: f.testFile, line: assert.line, message: f.message,
            ...(f.synth === undefined && tpl.diff ? { diff: tpl.diff } : {}),
            frames, group: f.group,
            ...(tpl.coveredChanged ? { coveredChanged: [`${frames[0].file}:${frames[0].line}`] } : {}),
          },
        });
      }
    }
    clocks[w] = t;
  }
  raw.sort((a, b) => a.at - b.at);
  const span = Math.max(1, raw.at(-1)?.at ?? 1);
  const scale = o.durationMs / span;
  for (const r of raw) r.at = Math.round(r.at * scale);
  for (const r of raw) if (r.ev.ev === 'failure') r.ev.seq = ++seq;

  // --- progress + fix loop + run-start/run-end
  const out: Timed[] = [];
  const projects: Record<string, { total: number; files: number }> = {};
  for (const [f, arr] of perFile) {
    if (!arr.length) continue;
    const p = (projects[projectOf(f)] ??= { total: 0, files: 0 });
    p.total += arr.length; p.files++;
  }
  out.push({ at: 0, ev: { ev: 'run-start', runId: o.runId, kind: o.kind, total: o.tests, files: files.filter((f) => perFile.get(f)!.length).length, pool: o.pool, ...(o.projectTotals ? { projects } : {}) } });
  let done = 0, failed = 0, passed = 0, skipped = 0;
  const every = Math.max(1, Math.floor(o.tests / 60));
  const failTimes: Array<{ at: number; id: string; group: string }> = [];
  for (const r of raw) {
    out.push(r);
    if (r.ev.ev === 'failure') failTimes.push({ at: r.at, id: r.ev.id as string, group: r.ev.group as string });
    if (r.ev.ev === 'test') {
      done++;
      if (r.ev.state === 'fail') failed++; else if (r.ev.state === 'skip') skipped++; else passed++;
      if (done % every === 0) out.push({ at: r.at, ev: { ev: 'progress', runId: o.runId, done, failed, etaMs: Math.max(0, Math.round(o.durationMs - r.at)) } });
    }
  }
  // fix during run: the price group gets fixed (user saved format.ts), the cart group is retried but still fails
  const cands = [...failTimes.filter((x) => x.group === 'g-31f0'), ...failTimes.filter((x) => x.group !== 'g-31f0' && x.group !== 'g-0c9d')];
  for (const f of cands.slice(0, o.fixDuringRun)) {
    const at = Math.min(o.durationMs - 1, f.at + o.durationMs * 0.25);
    out.push({ at, ev: { ev: 'fix-rerun', runId: o.runId, id: f.id, state: 'pass' } });
  }
  const cart = failTimes.find((x) => x.group === 'g-0c9d');
  if (cart && o.fixDuringRun > 0) out.push({ at: Math.min(o.durationMs - 1, cart.at + o.durationMs * 0.15), ev: { ev: 'fix-rerun', runId: o.runId, id: cart.id, state: 'fail' } });
  out.sort((a, b) => a.at - b.at);
  out.push({ at: o.durationMs + 20, ev: { ev: 'progress', runId: o.runId, done, failed, etaMs: 0 } });
  out.push({ at: o.durationMs + 30, ev: { ev: 'run-end', runId: o.runId, passed, failed, skipped, ms: o.durationMs + 30 } });
  return out;
}
