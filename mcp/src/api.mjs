// One method table for every transport (in-process, daemon IPC, CLI). Validates inputs strictly:
// typed filters only, paths must resolve inside the project root, git refs pass validBase,
// numeric limits are clamped. No Vitest CLI flags/argv ever reach Vitest.
import path from 'node:path';
import { userError } from './errors.mjs';
import { validBase } from './git.mjs';
import { canonicalFile, relKey } from './paths.mjs';
import { tokens } from './format.mjs';

const KINDS = new Set(['affected', 'full', 'tests', 'failed']);
const lane = (v) => (v == null ? undefined : ['main', 'fix', 'clean'].includes(v) ? v : (() => { throw userError('lane must be main, fix or clean'); })());
const num = (v, def, min, max) => (v == null ? def : Math.max(min, Math.min(max, Math.floor(Number(v)) || def)));
const str = (v, max = 512) => { if (v == null) return undefined; if (typeof v !== 'string') throw userError('expected a string'); if (v.length > max) throw userError('string too long'); return v; };

function relInside(eng, p, what = 'file') {
  p = str(p, 1024);
  if (p == null) return undefined;
  if (p.includes('\0')) throw userError(`invalid ${what}`);
  // D2: clients spell paths their own way (symlinked root, lower-case drive letter, NFD) – canonicalise
  // before the "inside the root" check, so neither a spelling nor a symlink escapes or misses the map
  const abs = canonicalFile(path.resolve(eng.root, p));
  const rel = relKey(eng.root, abs);
  if (!rel || rel === abs || rel.startsWith('../') || rel === '..') throw userError(`${what} must be inside the project root`);
  return eng.store.relOf(eng.store.canon(abs));
}
function base(v) { if (v == null) return undefined; if (!validBase(v)) throw userError('base must be a git ref/sha ([A-Za-z0-9._/~^@{}-], not starting with "-")'); return v; }
function testId(v) { v = str(v, 1200); if (!v) throw userError('test is required'); return v; }
function filters(eng, fs) {
  if (!Array.isArray(fs) || !fs.length || fs.length > 200) throw userError('filters: 1–200 objects {file?, line?, name?}');
  return fs.map((f) => {
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw userError('filters must be objects {file, line?, name?} (typed filters only)');
    for (const k of Object.keys(f)) if (!['file', 'line', 'name'].includes(k)) throw userError(`unknown filter field "${k}"`);
    return { file: relInside(eng, f.file), line: f.line == null ? undefined : num(f.line, 1, 1, 1e7), name: str(f.name, 200) };
  });
}

export const METHODS = {
  status: (e) => e.status(),
  affected: (e, p) => e.affected({ base: base(p.base), limit: num(p.limit, 20, 1, 100), cursor: str(p.cursor, 20) }),
  start_run: (e, p) => {
    const kind = p.kind ?? 'affected';
    if (!KINDS.has(kind)) throw userError(`kind must be one of ${[...KINDS].join(', ')}`);
    if (Array.isArray(e.config.mcpAllowRuns) && p.__via === 'mcp' && !e.config.mcpAllowRuns.includes(kind)) throw userError(`run kind "${kind}" is not allowed by the mcpAllowRuns setting (user-level vto config or .vto/config.json)`);
    return e.startRun({ kind, base: base(p.base), filters: kind === 'tests' ? filters(e, p.filters) : undefined, ids: Array.isArray(p.ids) ? p.ids.slice(0, 500).map((x) => testId(x)) : undefined,
      bail: num(p.bail, 0, 0, 1000), timeoutS: p.timeoutS == null ? undefined : num(p.timeoutS, 600, 1, 3600), instrumented: p.instrumented !== false, lane: lane(p.lane) });
  },
  wait_run: (e, p) => e.waitRun(str(p.runId, 40), { timeoutS: p.timeoutS == null ? undefined : num(p.timeoutS, 600, 1, 3600) }),
  run_status: (e, p) => e.runStatus({ runId: str(p.runId, 40) }),
  next_failures: (e, p) => e.nextFailures({ runId: str(p.runId, 40), cursor: str(p.cursor, 20), waitS: num(p.waitS, 20, 0, 30), limit: num(p.limit, 5, 1, 20) }),
  cancel_run: (e, p) => e.cancelRun({ runId: str(p.runId, 40) }),
  rerun_failed: (e, p) => e.rerunFailed({ runId: str(p.runId, 40), ids: Array.isArray(p.ids) ? p.ids.slice(0, 500).map(testId) : undefined, lane: lane(p.lane) }),
  enqueue_task: (e, p) => e.enqueueTask({ runId: str(p.runId, 40), group: str(p.group, 20), ids: Array.isArray(p.ids) ? p.ids.slice(0, 200).map(testId) : undefined, note: str(p.note, 500), source: p.__via === 'mcp' ? 'mcp' : /^vto-tui/.test(String(p.__client || '')) ? 'tui' : 'ipc', client: p.__client }),
  list_tasks: (e, p) => e.listTasks({ status: ['open', 'claimed', 'done', 'dropped', 'all'].includes(p.status) ? p.status : 'open', limit: num(p.limit, 10, 1, 50), cursor: str(p.cursor, 20) }),
  claim_task: (e, p) => e.claimTask({ taskId: str(p.taskId, 20), agent: str(p.agent, 60) }),
  complete_task: (e, p) => e.completeTask({ taskId: str(p.taskId, 20), status: str(p.status, 10) ?? 'done', note: str(p.note, 500) }),
  why_failed: (e, p) => e.whyFailed({ test: testId(p.test) }),
  coverage: (e, p) => e.coverage({ file: relInside(e, p.file), live: p.live !== false, detail: p.detail === 'full' ? 'full' : 'summary', limit: num(p.limit, 10, 1, 200), cursor: str(p.cursor, 20) }),
  tests_for: (e, p) => e.testsFor({ file: relInside(e, p.file), line: num(p.line, 1, 1, 1e7), limit: num(p.limit, 10, 1, 200), cursor: str(p.cursor, 20) }),
  lines_for: (e, p) => e.linesFor({ test: testId(p.test), limit: num(p.limit, 30, 1, 200), cursor: str(p.cursor, 20) }),
  test_overlap: (e, p) => e.testOverlap({ file: relInside(e, p.file), test: p.test ? testId(p.test) : undefined, limit: num(p.limit, 5, 1, 50), cursor: str(p.cursor, 20) }),
  slow_tests: (e, p) => e.slowTests({ file: relInside(e, p.file), limit: num(p.limit, 10, 1, 50), cursor: str(p.cursor, 20) }),
  slow_imports: (e, p) => e.slowImports({ file: relInside(e, p.file), limit: num(p.limit, 10, 1, 50), cursor: str(p.cursor, 20) }),
  suggest_env: (e, p) => e.suggestEnv({ file: relInside(e, p.file), limit: num(p.limit, 10, 1, 100), cursor: str(p.cursor, 20) }),
  vm_guard_status: (e) => e.vmGuardStatus({}),
  savings: (e, p) => e.savings({ since: /^\d+[dhm]$/.test(p.since || '') ? p.since : '30d' }),
  ci_summary: (e, p) => { const run = e.getRun(str(p.runId, 40)); return e.metrics.ciSummary({ ...run, pool: run.pool || e.poolName() }, e); },
  record_tokens: (e, p) => { e.metrics.recordTokens(str(p.tool, 60), num(p.tokens, 0, 0, 1e9), str(p.runId, 40)); return { ok: true }; },
};

export async function dispatch(eng, method, params = {}) {
  const fn = Object.prototype.hasOwnProperty.call(METHODS, method) ? METHODS[method] : null;
  if (!fn) throw Object.assign(new Error(`unknown method "${method}"`), { code: 'E_METHOD' });
  if (typeof params !== 'object' || Array.isArray(params)) throw userError('params must be an object');
  return fn(eng, params);
}

export { tokens };
