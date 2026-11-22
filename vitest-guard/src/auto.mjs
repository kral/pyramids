// mode: 'auto' – split test files into a DOM group and a pure-node group and run each in its best mode.
//
// Why: the gain of a fast pool depends on what a file spends its time on. vm contexts save the per-file
// jsdom setup, but pure-node files gain nothing from them and pay slower global access in hot code
// (the real-world suite, full suite, CPU: dom project vm −53.5 %, node project vm +9–10 % vs forks, shared −57 %).
import fs from 'node:fs';
import path from 'node:path';
import { readStateJson } from './statefs.mjs';
import { stripComments } from './scan.mjs';
import { foldEnvRecords, DOM_ENVS } from './envstore.mjs';
import { matchesGlobDot, globProjectFiles } from './safety.mjs';

export { DOM_ENVS };
// B5: Vitest globs with `dot: true` and excludes only what the user's exclude says (default node_modules, .git):
// a test file under build/, dist/, coverage/ or a dot directory runs there, so it must be in a group here too.
// Only directories that never hold the user's tests are skipped.
const SKIP_DIRS = new Set(['node_modules', '.git', '.vitest-guard']);

/**
 * Test files matching include/exclude (root-relative, '/' separators). Synchronous: runs at config time.
 * R5: globbed with Vitest's own tinyglobby and options (symlinked directories, `./` patterns, nested dot directories
 * behave exactly as in Vitest; excluded directories are pruned, S6). The directory walk below is only the fallback
 * when tinyglobby cannot be resolved; autoConfig adds a catch-all isolated project for anything a listing missed.
 */
export function listTestFiles(root, include, exclude, { maxFiles = 50000 } = {}) {
  const globbed = globProjectFiles(root, include, exclude);
  if (globbed) {
    if (globbed.length > maxFiles) console.warn(`[vitest-guard] auto: more than ${maxFiles} test files: the rest runs in the isolated catch-all group; use your own projects instead of mode 'auto'`);
    return globbed.slice(0, maxFiles);
  }
  const out = [];
  let warnedCap = false;
  const walk = (dir, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= maxFiles) { if (!warnedCap) { warnedCap = true; console.warn(`[vitest-guard] auto: more than ${maxFiles} test files: the rest is not in any group; use your own projects instead of mode 'auto'`); } return; }
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), r); continue; }
      if (!e.isFile()) continue;
      if (include.some((g) => matchesGlobDot(r, g)) && !exclude.some((g) => matchesGlobDot(r, g))) out.push(r);
    }
  };
  walk(root, '');
  return out.sort();
}

const DOM_IMPORT = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"`](@testing-library\/(?:react|dom|user-event|jest-dom|preact|vue|svelte)(?:\/[^'"`]*)?|react-dom(?:\/[^'"`]*)?|jsdom|happy-dom|@vue\/test-utils|enzyme)['"`]/;
const DOM_USE = /\b(renderHook|render)\s*\(|\b(document|window|navigator|localStorage|sessionStorage)\s*\.|\bnew\s+(MouseEvent|KeyboardEvent|CustomEvent|Event|DOMParser|MutationObserver)\b|\bscreen\.(get|query|find)/;

/** Explicit `@vitest-environment <name>` pragma (docblock or line comment), else null. */
export function envPragma(src) {
  const m = /@vitest-environment\s+([\w@/.-]+)/.exec(src.slice(0, 4000));
  return m ? m[1] : null;
}

/** Static classification: { group: 'dom'|'node', reason } */
export function staticGroup(file, src) {
  const pragma = envPragma(src);
  if (pragma) return { group: DOM_ENVS.has(pragma) ? 'dom' : 'node', reason: `pragma ${pragma}`, pragma };
  if (/\.[jt]sx$/.test(file)) return { group: 'dom', reason: 'JSX test file' };
  const s = stripComments(src);
  const imp = DOM_IMPORT.exec(s);
  if (imp) return { group: 'dom', reason: `imports ${imp[1]}` };
  const use = DOM_USE.exec(s);
  if (use) return { group: 'dom', reason: `uses ${use[0].trim().slice(0, 30)}` };
  return { group: 'node', reason: 'no DOM import or usage found' };
}

/**
 * Runtime evidence in `.vitest-guard/run/env.json` (format `vto-env/1`), shared with the vto daemon.
 * The file has ONE owner: src/envstore.mjs (precedence miss > probe > static, lock, atomic write). This folds
 * the per-worker probe records and vto's raw env records into it and returns the merged entries.
 */
export function readEnvEvidence(root) {
  return foldEnvRecords(root);
}

/**
 * @returns {{ dom: string[], node: string[], why: Record<string, string> }}
 * Default routing is by the CONFIGURED environment (file pragma, else `userEnv`): moving jsdom-configured
 * files elsewhere without changing their environment costs 2-3x CPU (jsdom per file in forks), and changing
 * their environment changes semantics. With `nodeEnvironment: 'node'` (opt-in) files of a DOM-configured suite
 * that never touch the DOM (measured, else static) go to the node group and run with environment node.
 */
export function classifyFiles(root, files, userEnv, { nodeEnvironment = null, evidence = readEnvEvidence(root) } = {}) {
  const dom = [], node = [], why = {};
  const userIsDom = DOM_ENVS.has(userEnv);
  for (const f of files) {
    let src = '';
    try { src = fs.readFileSync(path.join(root, f), 'utf8'); } catch {}
    const pragma = envPragma(src);
    let group, reason;
    if (pragma) { group = DOM_ENVS.has(pragma) ? 'dom' : 'node'; reason = `pragma ${pragma}`; }
    else if (!userIsDom) { group = 'node'; reason = `configured environment ${userEnv || 'node'}`; }
    else if (nodeEnvironment !== 'node') { group = 'dom'; reason = `configured environment ${userEnv}`; }
    else if (evidence[f] && evidence[f].source !== 'static') {
      const e = evidence[f];
      group = e.dom ? 'dom' : 'node';
      reason = e.miss ? `failed in node group (touched ${e.miss.key})` : `measured (${e.by || e.source}): ${e.dom ? 'touched DOM' : 'never touched DOM'}`;
    } else { const st = staticGroup(f, src); group = st.group; reason = 'static: ' + st.reason; }
    (group === 'dom' ? dom : node).push(f);
    why[f] = reason;
  }
  return { dom, node, why };
}

/** Stored per-group mode choice (.vitest-guard/run/modes.json, written by `vitest-guard compare` / `calibrate`). */
export function readModes(root) {
  // N9: a data file must not be able to inject anything but one of the three known modes
  try {
    const m = readStateJson(path.join(root, '.vitest-guard', 'run', 'modes.json'), null); // never through a symlink (S2)
    const out = {};
    if (m && typeof m === 'object' && m.modes && typeof m.modes === 'object' && !Array.isArray(m.modes)) for (const [k, v] of Object.entries(m.modes)) if (v === 'vm' || v === 'shared' || v === 'isolated') out[k] = v;
    return out;
  } catch { return {}; }
}

/** Defaults without measurements: DOM files gain most in vm; pure-node files gain most in shared. */
export const DEFAULT_AUTO_MODES = { dom: 'vm', node: 'shared' };

export { DOM_KEYS } from './realm.mjs';
