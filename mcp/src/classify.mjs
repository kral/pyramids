// Environment classification of test files → lane groups (dom / node), shared with vm-guard `mode: 'auto'`.
//
// Source of truth, in order:
//   1. measured: the env probe (collector-ext/setup-env-probe.mjs) recorded in the map: configured
//      environment `env` and whether the file touched any DOM global after the setup files (`dom`)
//   2. static fallback for files without a measurement: .tsx/.jsx, @testing-library, react-dom,
//      `document.` / `window.` / `screen.` in the test file → dom, otherwise node
// Groups decide the POOL only (dom → vm/shared, node → shared/forks); the test environment stays as
// configured, so semantics do not change. A file is `node` when its configured environment is node, or
// when it never touched the DOM (`dom:false`) – the latter still runs in its configured environment.
//
// Handed to vm-guard's envstore, the one writer of `.vm-guard/run/env.json` (format "vto-env/1",
// PROTOCOL.md §9, contracts/env-1.schema.json) – see src/env-json.mjs.
import fs from 'node:fs';
import path from 'node:path';

const DOM_ENVS = new Set(['jsdom', 'happy-dom', 'browser']);

export function staticGroup(absFile) {
  if (/\.[cm]?[jt]sx$/.test(absFile)) return 'dom';
  let src = '';
  try { src = fs.readFileSync(absFile, 'utf8').slice(0, 200000); } catch { return 'dom'; } // unknown → the safer, DOM-capable group
  if (/@testing-library\/|react-dom|\bdocument\.|\bwindow\.|\bscreen\.|@vitest-environment\s+(jsdom|happy-dom)/.test(src)) return 'dom';
  if (/@vitest-environment\s+node/.test(src)) return 'node';
  return 'node';
}

/** files: abs test files → Map abs → {group, source, env, dom} */
export function classify(eng, files) {
  const out = new Map();
  for (const f of files) {
    const e = eng.store.tests.get(f)?.env;
    if (e && (e.env || e.dom != null)) {
      const isNodeEnv = e.env && !DOM_ENVS.has(e.env);
      const group = isNodeEnv || e.dom === false ? 'node' : 'dom';
      out.set(f, { group, source: 'probe', env: e.env ?? null, dom: e.dom ?? null });
    } else out.set(f, { group: staticGroup(f), source: 'static', env: null, dom: null });
  }
  return out;
}

// env.json is written by src/env-json.mjs (vm-guard's envstore owns the merge rules)
export { writeEnvJson } from './env-json.mjs';

/** Split a worker budget between groups proportionally to their measured test time (each ≥ 1). */
export function splitWorkers(budget, msByGroup) {
  const groups = Object.keys(msByGroup);
  if (groups.length < 2 || budget < 2) return Object.fromEntries(groups.map((g) => [g, 1]));
  const total = groups.reduce((s, g) => s + (msByGroup[g] || 0), 0) || 1;
  const out = {};
  let left = budget;
  groups.forEach((g, i) => {
    const n = i === groups.length - 1 ? left : Math.max(1, Math.min(left - (groups.length - 1 - i), Math.round((budget * (msByGroup[g] || 0)) / total)));
    out[g] = n; left -= n;
  });
  return out;
}
