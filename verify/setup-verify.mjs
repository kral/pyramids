// vto verify – Vitest setupFile (prepended). Re-runs every planned test once per active mutant
// INSIDE the worker: test.repeats = n+1, attempt i activates schedule[i] via globalThis.__vto_mut.
// Schedule = [0 (baseline), m1, …, mn, 0 (baseline again → detects state contamination)].
// Each attempt appends one result line; failing mutant attempts are turned back into passes so the
// reporter stays quiet and the exit code reflects only baseline failures.
import { beforeAll, beforeEach } from 'vitest';
import { appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import { threadId } from 'node:worker_threads';

const G = globalThis;
const S = G.__vto_verify || (G.__vto_verify = (() => {
  const plan = JSON.parse(readFileSync(process.env.VTO_VERIFY_PLAN, 'utf8'));
  mkdirSync(plan.outDir, { recursive: true });
  return { plan, out: `${plan.outDir}/r-${process.pid}-${threadId}.jsonl` };
})());
const now = () => performance.now();

if (S.plan.asyncUtilTimeout) {
  // shorter waitFor/findBy timeout: a killed mutant otherwise waits the full default (1 s) per attempt.
  // Resolve @testing-library/dom the way @testing-library/react does (same CJS instance as the tests).
  try {
    const { createRequire } = await import('node:module');
    const fromRoot = createRequire(`${process.cwd()}/package.json`);
    let req = fromRoot;
    try { req = createRequire(fromRoot.resolve('@testing-library/react')); } catch {}
    req('@testing-library/dom').configure({ asyncUtilTimeout: S.plan.asyncUtilTimeout });
  } catch {}
}

function fullName(task) {
  const names = [task.name];
  for (let s = task.suite; s && s !== task.file && s.name; s = s.suite) names.unshift(s.name);
  return names.join(' > ');
}

function* testsOf(suite) {
  for (const t of suite.tasks || []) {
    if (t.type === 'test') yield t;
    else if (t.type === 'suite') yield* testsOf(t);
  }
}

beforeAll(({}, file) => {
  for (const t of testsOf(file)) {
    const key = `${t.file.filepath}::${t.fullTestName ?? fullName(t)}`;
    const ms = S.plan.tests[key];
    if (!ms || t.mode !== 'run') { if (t.mode === 'run') t.mode = 'skip'; continue; }
    t.__vto = { key, sched: S.plan.baseline === false ? ms : [0, ...ms, 0] };
    t.repeats = t.__vto.sched.length - 1;
    t.retry = 0;
  }
});

beforeEach((ctx) => {
  const t = ctx.task, v = t.__vto;
  if (!v) return;
  const i = t.result?.repeatCount ?? 0;
  const m = v.sched[i] ?? 0;
  appendFileSync(S.out, `{"s":${JSON.stringify(v.key)},"m":${m},"i":${i}}\n`);
  G.__vto_mut = m;
  const t0 = now();
  ctx.onTestFinished(() => {
    G.__vto_mut = 0;
    const failed = t.result?.state === 'fail';
    let e;
    if (failed) {
      const err = t.result.errors?.[t.result.errors.length - 1];
      e = String(err?.message ?? err ?? '').slice(0, 160);
    }
    appendFileSync(S.out, JSON.stringify({ k: v.key, m, i, f: failed ? 1 : 0, ms: Math.round((now() - t0) * 100) / 100,
      ...(failed ? { e } : {}) }) + '\n');
    if (failed && m !== 0) { t.result.state = 'pass'; t.result.errors = undefined; }
  });
});
