// vto v1 collector (`--engine v8`, fallback) – Vitest setupFile, prepended by the runner.
// Takes V8 precise coverage per test via node:inspector: counters are reset in our beforeEach
// (first beforeEach) and collected in an onTestFinished callback (runs after afterEach hooks,
// beforeEach cleanups and fixture teardown). Records are buffered per test file and flushed in
// afterAll; script sources are fetched lazily at flush time (Debugger enabled only then).
// Writes $VTO_RAW_DIR/w-<pid>-<thread>.jsonl – see FORMAT.md (v1).
import { Session } from 'node:inspector';
import { appendFileSync, mkdirSync } from 'node:fs';
import { threadId } from 'node:worker_threads';
import { beforeEach, afterAll, expect } from 'vitest';
import vm from 'node:vm';

const G = globalThis as any;
const realImmediate = G.setImmediate?.bind(G);

// synchronous inspector calls (same-thread sessions answer synchronously)
function post(session: Session, method: string, params?: object): any {
  let res: any, err: any, done = false;
  session.post(method as any, params as any, (e: any, r: any) => { err = e; res = r; done = true; });
  if (!done) throw new Error(`vto: inspector call ${method} did not complete synchronously`);
  if (err) throw err;
  return res;
}

// per-worker state (inspector session, buffers, exit hook) in the worker's outer realm – vm pools
// create a fresh globalThis per test file (see setup-v2.mjs)
let OUTER: any = G;
try { OUTER = vm.runInThisContext('globalThis'); } catch {}
const S = OUTER.__vto_v8 || (OUTER.__vto_v8 = (() => {
  const dir = process.env.VTO_RAW_DIR;
  if (!dir) throw new Error('vto: VTO_RAW_DIR is not set (run through vitest-overlap)');
  mkdirSync(dir, { recursive: true });
  const session = new Session();
  session.connect();
  post(session, 'Profiler.enable');
  post(session, 'Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  const st: any = {
    session, out: `${dir}/w-${process.env.VTO_RUN_ID || 'x'}-${process.pid}-${threadId}.jsonl`,
    keep: new Map<string, boolean>(),   // url -> is project script
    urlToId: new Map<string, string>(), // url -> scriptId (latest)
    emitted: new Set<string>(),         // urls whose source was written to this worker file
    pending: new Map<string, any>(), active: 0,
  };
  st.flush = () => {
    if (!st.pending.size) return;
    let lines = '';
    const need = new Set<string>();
    for (const r of st.pending.values()) for (const c of r.cov) if (!st.emitted.has(c.url)) need.add(c.url);
    if (need.size) {
      post(session, 'Debugger.enable');
      for (const url of need) {
        try {
          const { scriptSource } = post(session, 'Debugger.getScriptSource', { scriptId: st.urlToId.get(url) });
          lines += JSON.stringify({ t: 'script', url, source: scriptSource }) + '\n';
          st.emitted.add(url);
        } catch { /* script collected – its records stay; analyzer may drop the url */ }
      }
      post(session, 'Debugger.disable');
    }
    for (const r of st.pending.values()) {
      const t = r.task, state = t.result?.state;
      lines += JSON.stringify({
        t: 'test', file: t.file?.filepath, name: r.name, line: t.location?.line ?? null,
        state: state === 'fail' ? 'fail' : 'pass', durationMs: r.durationMs, assertions: r.assertions,
        ...(r.tainted ? { tainted: true } : {}), cov: r.cov,
      }) + '\n';
    }
    st.pending.clear();
    appendFileSync(st.out, lines);
  };
  process.on('exit', () => { try { st.flush(); } catch {} });
  return st;
})());

const self = import.meta.url;
const excluded = new Set<string>(JSON.parse(process.env.VTO_EXCLUDE_URLS || '[]'));
const TEST_RE = /\.(test|spec|bench)\.[cm]?[jt]sx?$/;
function isProject(url: string): boolean {
  let k = S.keep.get(url);
  if (k === undefined) {
    k = url.startsWith('file://') && url !== self && !excluded.has(url) &&
      !/\/(node_modules|__mocks__|__tests__|\.vite)\//.test(url) && !TEST_RE.test(url) && !url.includes('/vto/collector/');
    S.keep.set(url, k);
  }
  return k;
}

beforeEach((ctx: any) => {
  const task = ctx.task;
  let tainted = ++S.active > 1;
  post(S.session, 'Profiler.takePreciseCoverage'); // reset counters
  const t0 = performance.now();
  ctx.onTestFinished(async () => {
    if (realImmediate) await new Promise((r) => realImmediate(r));
    const { result } = post(S.session, 'Profiler.takePreciseCoverage');
    const durationMs = Math.round((performance.now() - t0) * 1000) / 1000;
    let assertions: number | null = null;
    try { assertions = (ctx._local ? ctx.expect : (G[Symbol.for('expect-global')] ?? expect)).getState().assertionCalls ?? null; } catch {}
    const testUrl = 'file://' + task.file?.filepath;
    const cov: any[] = [];
    for (const sc of result) {
      if (sc.url === testUrl || !isProject(sc.url)) continue;
      let any = false;
      for (const f of sc.functions) { for (const r of f.ranges) if (r.count > 0) { any = true; break; } if (any) break; }
      if (!any) continue;
      S.urlToId.set(sc.url, sc.scriptId);
      cov.push({ url: sc.url, functions: sc.functions.map((f: any) => f.ranges.map((r: any) => [r.startOffset, r.endOffset, r.count])) });
    }
    if (S.active > 1) tainted = true;
    S.active--;
    S.pending.set(task.id, { task, name: task.fullTestName ?? task.name, durationMs, assertions, cov, tainted });
  });
});

afterAll(() => S.flush());
