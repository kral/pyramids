// Static scan of test files for shared-mode (isolate:false) risk traits. Regex + brace-depth heuristics on
// comment-stripped source; deliberately conservative (false positives only cost parallelism).
import fs from 'node:fs';
import path from 'node:path';

export function stripComments(src) {
  let out = '', i = 0, q = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (q) { out += c; if (c === '\\') { out += n ?? ''; i += 2; continue; } if (c === q) q = null; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const chunk = src.slice(i, e < 0 ? src.length : e + 2); out += chunk.replace(/[^\n]/g, ' '); i = e < 0 ? src.length : e + 2; continue; }
    out += c; i++;
  }
  return out;
}

const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
export const pkgName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
const isBare = (s) => !s.startsWith('.') && !s.startsWith('/') && !s.startsWith('~') && !s.startsWith('@/') && !s.startsWith('#') && !s.startsWith('virtual:');

function balanced(src, open) { // index of ')' matching src[open] === '('
  let d = 0, q = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '(') d++;
    else if (c === ')' && --d === 0) return i;
  }
  return src.length;
}

const TOP_OK = /^(import\b|export\s+(type|interface|\{|\*|default\s+(function|class))|export\s+(const|let|function|class|async)|const\b|let\b|var\b|function\b|async\s+function\b|class\b|type\b|interface\b|declare\b|enum\b|describe(\.\w+)*\s*[(`]|it(\.\w+)*\s*[(`]|test(\.\w+)*\s*[(`]|suite(\.\w+)*\s*[(`]|bench\b|(before|after)(All|Each)\s*\(|vi\.(mock|doMock|unmock|hoisted|setConfig)\s*\(|expect\.extend\s*\(|expect\.addEqualityTesters\s*\(|\}|\)|\]|;|$)/;

/** @returns {object} traits of one test file */
export function scanSource(src, file = '') {
  const s = stripComments(src);
  const dir = path.dirname(file);
  const mocks = [];
  for (const m of s.matchAll(/\bvi\.(mock|doMock)\s*\(\s*(['"`])([^'"`]+)\2/g)) {
    const spec = m[3];
    const open = s.indexOf('(', m.index);
    const close = balanced(s, open);
    const args = s.slice(open + 1, close);
    const comma = args.indexOf(',', args.indexOf(m[2] + spec + m[2]) + spec.length + 2);
    const factory = comma >= 0 ? args.slice(comma + 1).replace(/\s+/g, ' ').trim() : '';
    const bare = isBare(spec);
    const target = bare ? pkgName(spec) + spec.slice(pkgName(spec).length) : path.resolve(dir, spec).replace(/\.(m?[jt]sx?)$/, '');
    mocks.push({ kind: m[1], spec, target, bare, pkg: bare ? pkgName(spec) : null, factory: factory ? hash(factory) : 'automock' });
  }
  const imports = new Set();
  for (const m of s.matchAll(/(?:\bimport\s*(?:[\w*{}\s,$]+from\s*)?|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"`])([^'"`]+)\1/g)) if (isBare(m[2])) imports.add(pkgName(m[2].replace(/^node:/, 'node:')));
  const relImports = [];
  for (const m of s.matchAll(/(?:\bimport\s*(?:[\w*{}\s,$]+from\s*)?|\bimport\s*\(\s*)(['"`])(\.[^'"`]+)\1/g)) relImports.push(path.resolve(dir, m[2]));
  const has = (re) => re.test(s);
  const traits = {
    stubGlobal: has(/\bvi\.stubGlobal\s*\(/) && !has(/\bvi\.unstubAllGlobals\s*\(/),
    stubEnv: has(/\bvi\.stubEnv\s*\(/) && !has(/\bvi\.unstubAllEnvs\s*\(/),
    fakeTimers: has(/\bvi\.useFakeTimers\s*\(/) && !has(/\bvi\.useRealTimers\s*\(/),
    spies: has(/\bvi\.spyOn\s*\(/) && !has(/\b(vi\.restoreAllMocks|mockRestore)\s*\(/),
    globalAssign: [...s.matchAll(/(?:^|[^\w.$])((?:window|globalThis|global|self|document|navigator|Date|Math|console|Element\.prototype|HTMLElement\.prototype|process\.env)\.[\w$.]+)\s*=(?!=)/g)].map((m) => m[1]),
    reactRoot: has(/\bcreateRoot\s*\(/) && !has(/\.unmount\s*\(/),
    domListener: has(/\b(window|document)\.addEventListener\s*\(/) && !has(/\b(window|document)\.removeEventListener\s*\(/),
    storage: has(/\b(localStorage|sessionStorage)\.setItem\s*\(/) && !has(/\b(localStorage|sessionStorage)\.clear\s*\(/),
    domDirect: has(/document\.(body|head)\.(append|appendChild|insertBefore|prepend|innerHTML)/),
    topLevel: [],
  };
  // top-level statements outside the allow-list (brace depth 0)
  let depth = 0, q = null, line = '', lineNo = 1, startLine = 1;
  const flush = () => { const t = line.trim(); if (t && !TOP_OK.test(t)) traits.topLevel.push({ line: startLine, text: t.slice(0, 80) }); line = ''; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\n') { lineNo++; if (depth === 0 && !q) flush(); else if (depth === 0) line += c; startLine = depth === 0 ? lineNo : startLine; continue; }
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; if (depth === 0) line += c; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; if (depth === 0) line += c; continue; }
    if (c === '{' || c === '(' || c === '[') { if (depth === 0) line += c; depth++; continue; }
    if (c === '}' || c === ')' || c === ']') { depth = Math.max(0, depth - 1); if (depth === 0) line += c; continue; }
    if (depth === 0) line += c;
  }
  flush();
  traits.topLevel = traits.topLevel.filter((t) => !/^(import|export)\b/.test(t.text));
  // classify
  const pollutes = [];
  if (mocks.some((m) => m.bare)) pollutes.push('mock:node_modules');
  if (traits.globalAssign.length) pollutes.push('global-assign');
  if (traits.topLevel.length) pollutes.push('top-level-side-effect');
  const mitigated = ['stubGlobal', 'stubEnv', 'fakeTimers', 'spies', 'reactRoot', 'domListener', 'storage', 'domDirect'].filter((k) => traits[k]);
  return { file, mocks, imports: [...imports], relImports, traits, pollutes, mitigated };
}

export function scanFile(file) {
  return scanSource(fs.readFileSync(file, 'utf8'), file);
}

/** Heuristic: module-level mutable state in a project source module (top-level let/var, or a mutated top-level collection). */
export function isStatefulModule(src) {
  const s = stripComments(src);
  if (/^(export\s+)?(let|var)\s+[\w$]/m.test(s)) return true;
  const coll = [...s.matchAll(/^(?:export\s+)?const\s+([\w$]+)\s*=\s*(?:new\s+(?:Map|Set|WeakMap)\b|\[|\{)/gm)].map((m) => m[1]);
  return coll.some((n) => new RegExp(`\\b${n}\\s*(\\.(set|add|push|delete|clear|splice)\\s*\\(|\\[[^\\]]+\\]\\s*=(?!=)|\\.[\\w$]+\\s*=(?!=))`).test(s));
}
