// Performance benchmark: the real <App> in Ink's interactive (TTY) code path on a fake terminal,
// fed by the mock at high event rates. Reports reducer cost, Ink render time per frame, event-loop
// blocking (= input latency), bytes written per frame, memory.
//
//   npm run bench -- [opts]   (= node --expose-gc --import tsx bench/bench.tsx)
//   opts: [--tests 10000] [--failures 500] [--duration 2000] [--cols 160] [--rows 48]
import { monitorEventLoopDelay } from 'node:perf_hooks';
import path from 'node:path';
// React's production build, like bin/vto-ui.mjs (must be set before React is loaded)
process.env.NODE_ENV ??= 'production';
const { RunStore } = await import('../src/model.js');
const { MockSource } = await import('../src/mock/source.js');
const { DEFAULT_MOCK } = await import('../src/mock/scenario.js');
const { initTerm } = await import('../src/term.js');
const { setLocale } = await import('../src/i18n.js');
const { renderApp, KEYS } = await import('../test/harness.js');

const arg = (k: string, d: number) => { const i = process.argv.indexOf('--' + k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const TESTS = arg('tests', 10_000), FAILS = arg('failures', 500), DURATION = arg('duration', 2000);
const COLS = arg('cols', 160), ROWS = arg('rows', 48);
const ROOT = path.resolve(import.meta.dirname, '../dev/fixture');

initTerm({ colorLevel: 3, unicode: true });
setLocale('cs');

const pct = (a: number[], q: number) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const mb = (b: number) => (b / 1048576).toFixed(1) + ' MB';

async function scenario(name: string, opts: { speed?: number; burst?: boolean; incremental?: boolean; keys?: boolean }) {
  if (global.gc) global.gc();
  const mem0 = process.memoryUsage();
  const store = new RunStore();
  const src = new MockSource({ ...DEFAULT_MOCK, root: ROOT, tests: TESTS, failures: FAILS, files: Math.round(TESTS / 25), durationMs: DURATION, speed: opts.speed ?? 1, tickMs: 4 });
  const renders: number[] = [];
  let applyMs = 0;
  const origApply = store.applyMany.bind(store);
  store.applyMany = (evs) => { const t = performance.now(); origApply(evs); applyMs += performance.now() - t; };
  const r = renderApp({ store, source: src, root: ROOT, columns: COLS, rows: ROWS, interactive: true, incremental: opts.incremental ?? true, batchMs: 33, onRender: (ms) => renders.push(ms) });
  const lag = monitorEventLoopDelay({ resolution: 5 });
  lag.enable();
  const t0 = performance.now();
  let keyTimer: NodeJS.Timeout | null = null;
  if (opts.keys) keyTimer = setInterval(() => r.stdin.write(Math.random() < 0.5 ? KEYS.down : 'j'), 60);
  if (opts.burst) {
    src.start({ onEvents: (e) => store.applyMany(e) });
    src.close();
    src.drain(500);
  } else {
    src.start({ onEvents: (e) => store.applyMany(e) });
    while (!src.finished) await new Promise((res) => setTimeout(res, 20));
  }
  const tStream = performance.now() - t0;
  await new Promise((res) => setTimeout(res, 300)); // let the last batched frame flush
  if (keyTimer) clearInterval(keyTimer);
  lag.disable();
  const mem1 = process.memoryUsage();
  const run = store.current!;
  const result = {
    scenario: name,
    events: store.eventsApplied,
    'stream wall': tStream.toFixed(0) + ' ms',
    'events/s': Math.round(store.eventsApplied / (tStream / 1000)),
    failures: run.failures.size,
    groups: run.groupOrder.length,
    frames: renders.length,
    'render p50': pct(renders, 0.5).toFixed(2) + ' ms',
    'render p95': pct(renders, 0.95).toFixed(2) + ' ms',
    'render max': pct(renders, 1).toFixed(2) + ' ms',
    'reducer total': applyMs.toFixed(1) + ' ms',
    'loop lag p99': (lag.percentile(99) / 1e6).toFixed(1) + ' ms',
    'loop lag max': (lag.max / 1e6).toFixed(1) + ' ms',
    'stdout total': mb(r.stdout.bytes),
    'bytes/frame': Math.round(r.stdout.bytes / Math.max(1, r.stdout.writes)),
    'heap Δ': mb(mem1.heapUsed - mem0.heapUsed),
    rss: mb(mem1.rss),
  };
  r.unmount();
  src.close();
  return result;
}

await scenario('warm-up (JIT)', { speed: 4 }); // not reported
const results = [];
results.push(await scenario(`real-time ${TESTS} tests/${DURATION} ms + keys`, { keys: true }));
results.push(await scenario('same, full redraw (incrementalRendering off)', { incremental: false }));
results.push(await scenario('burst: whole run at once (batches of 500)', { burst: true }));
console.table(results.map((r) => ({ ...r })));
console.log(JSON.stringify({ tests: TESTS, failures: FAILS, durationMs: DURATION, cols: COLS, rows: ROWS, node: process.version, results }, null, 1));
process.exit(0);
