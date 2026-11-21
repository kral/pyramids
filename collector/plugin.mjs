// vto v2 instrumentation – Vite plugin (enforce: 'pre').
// Parses project source files (TS/TSX/JS/JSX) with oxc-parser and inserts hit markers
// (`__vto_k[i]=1`) with magic-string. Block positions are ORIGINAL source positions; the block
// table is embedded in the module (globalThis.__vto_blk[file], a JSON string) so that the worker
// that executes the module writes the `{"t":"file"}` record itself (works with Vitest's
// fsModuleCache, which skips transforms). See FORMAT.md (v2). setup-v2.mjs resets/collects.
import { parseSync } from 'oxc-parser';
import MagicString from 'magic-string';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { contentHash } from './hash.mjs';
import { canonicalFile } from './paths.mjs';

const EXT = /\.(?:[cm]?[jt]sx?)$/;
const TEST_RE = /\.(?:test|spec|bench)\.[cm]?[jt]sx?$/;
const DIR_EXCLUDE = /\/(?:node_modules|__mocks__|__tests__|__fixtures__)\//;
// Per-file opt-out: a comment `/* vto-ignore-file */` (or `// vto-ignore-file`) anywhere in a module leaves
// its code untouched – no markers inside functions, so `fn.toString()` / code built from it (worker and
// page.evaluate helpers, `new Function(String(fn))`) keeps working. The module is still registered with an
// empty block table: any change to it selects every test file that loads it.
const IGNORE_FILE = /\/\*[\s*]*vto-ignore-file\b[^]*?\*\/|\/\/[ \t]*vto-ignore-file\b/;
export const hasIgnorePragma = (code) => code.includes('vto-ignore-file') && IGNORE_FILE.test(code);

// keys that only hold type information – never visited
const TYPE_KEYS = new Set(['typeAnnotation', 'returnType', 'typeParameters', 'typeArguments',
  'superTypeArguments', 'superTypeParameters', 'implements', 'decorators']);
// TS nodes that wrap runtime code (visited); every other TS* node is type-only / skipped
const TS_RUNTIME = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression',
  'TSTypeAssertion', 'TSInstantiationExpression', 'TSParameterProperty', 'TSExportAssignment']);
const FN = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const LOOP = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);
const COMPOUND = new Set(['IfStatement', 'SwitchStatement', 'TryStatement', 'LabeledStatement', 'BlockStatement',
  'ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement', ...LOOP]);

function lineIndex(code) {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) starts.push(i + 1);
  return (off) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return [lo + 1, off - starts[lo]]; // 1-based line, 0-based UTF-16 column
  };
}

/**
 * Instruments `code`. Returns { code, map, blocks } or null when there is nothing to do.
 * sha256: content hash of the file on disk (hash.mjs); default: hash of `code`.
 * blocks: [[startLine,startCol,endLine,endCol,kind], ...]   kind: f | b | s
 */
export function instrument(code, filename, { sourceMap = true, sha256 = null } = {}) {
  const lang = /\.[cm]?tsx$/.test(filename) ? 'tsx' : /\.[cm]?ts$/.test(filename) ? 'ts'
    : /\.[cm]?jsx$/.test(filename) ? 'jsx' : 'js';
  const res = parseSync(filename, code, { lang, sourceType: 'module', preserveParens: true });
  if (res.errors?.some((e) => e.severity === 'Error' || !e.severity)) return null;
  const s = new MagicString(code);
  const pos = lineIndex(code);
  const blocks = [];
  // module-local identifiers; if the source itself mentions `__vto`, use a random per-file prefix so
  // user identifiers can never collide with ours (F14)
  const P = code.includes('__vto') ? `__vto_x${randomBytes(4).toString('hex')}_` : '__vto_';
  const K = `${P}k`, I = `${P}i`;
  const add = (start, end, kind) => {
    const [l1, c1] = pos(start), [l2, c2] = pos(end);
    blocks.push([l1, c1, l2, c2, kind]);
    return blocks.length - 1;
  };
  // Marker target. Cheapest form: a function-local const alias of the hit array (`__vto_l[i]=1`).
  // Hoisted function declarations may run before the prelude (import cycles) → their alias is taken
  // through the hoisted accessor `(__vto_k||__vto_i())` once per call. Module top level and anything
  // created after the prelude ran use the module var directly.
  const ACC = `(${K}||${I}())`, L = `${P}l`, T = `${P}t`;
  let A = K;          // current marker target expression
  let hoisted = 0;    // >0 while inside a FunctionDeclaration's parameter list (no local alias yet)
  const mark = (i) => `;${A}[${i}]=1;`; // leading `;`: a target starting with `(` is an ASI hazard after `foo()\n`
  // all openings: appendRight (pre-order → outer first); all closings: prependLeft (pre-order → outer last)
  const open = (at, text) => s.appendRight(at, text);
  const close = (at, text) => s.prependLeft(at, text);
  const wrapExpr = (node, kind, region = node) => {
    const i = add(region.start, region.end, kind);
    open(node.start, `(${A}[${i}]=1,`); close(node.end, ')');
  };
  // anonymous function/class definitions get their .name from the binding (NamedEvaluation);
  // wrapping them in `(k=1, fn)` would drop it → leave those values unwrapped
  const anonFn = (n) => {
    while (n.type === 'ParenthesizedExpression') n = n.expression;
    return (n.type === 'ArrowFunctionExpression' || ((n.type === 'FunctionExpression' || n.type === 'ClassExpression') && !n.id));
  };
  /** marker at the start of a statement position: block → after `{` (+ directives), else wrap in braces */
  const markStmt = (st, kind, region = st, after = '') => {
    const i = add(region.start, region.end, kind);
    if (st.type === 'BlockStatement') { open(st.start + 1, mark(i)); if (after) close(st.end, after); }
    else { open(st.start, `{${mark(i)}`); close(st.end, '}' + after); }
  };

  function visitList(list, topLevel) {
    for (let i = 0; i < list.length; i++) {
      const st = list[i];
      if (!topLevel && i > 0 && COMPOUND.has(list[i - 1].type) && abrupt(list[i - 1]) && !isTypeOnly(st)) {
        const j = add(st.start, list[list.length - 1].end, 's');
        open(st.start, mark(j));
      }
      visit(st);
    }
  }
  // can `st` complete abruptly (return / throw / break or continue leaving it)? Otherwise the code after
  // it always runs when `st` started, and a continuation block would only duplicate the parent's hit.
  function abrupt(st) {
    let found = false;
    // loops: enclosing loops+switches inside st (targets of unlabeled break); cont: enclosing loops (continue)
    const walk = (n, loops, labels, cont = loops) => {
      if (found || !n || typeof n.type !== 'string') return;
      switch (n.type) {
        case 'ReturnStatement': case 'ThrowStatement': found = true; return;
        case 'BreakStatement': if (n.label ? !labels.has(n.label.name) : loops === 0) found = true; return;
        case 'ContinueStatement': if (n.label ? !labels.has(n.label.name) : cont === 0) found = true; return;
        case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': case 'ClassBody': return;
        case 'LabeledStatement': walk(n.body, loops, new Set([...labels, n.label.name]), cont); return;
        case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': case 'WhileStatement': case 'DoWhileStatement': case 'SwitchStatement': {
          const c2 = n.type === 'SwitchStatement' ? cont : cont + 1;
          for (const k in n) if (k !== 'type') { const v = n[k]; if (Array.isArray(v)) v.forEach((c) => walk(c, loops + 1, labels, c2)); else if (v && typeof v === 'object') walk(v, loops + 1, labels, c2); }
          return;
        }
      }
      for (const k in n) {
        if (k === 'type' || TYPE_KEYS.has(k)) continue;
        const v = n[k];
        if (Array.isArray(v)) { for (const c of v) walk(c, loops, labels, cont); } else if (v && typeof v === 'object') walk(v, loops, labels, cont);
      }
    };
    walk(st, 0, new Set());
    return found;
  }
  function isTypeOnly(n) {
    return (n.type.startsWith('TS') && !TS_RUNTIME.has(n.type)) || n.declare === true ||
      ((n.type === 'ExportNamedDeclaration' || n.type === 'ImportDeclaration') && n.exportKind === 'type') ||
      (n.type === 'ExportNamedDeclaration' && n.declaration && isTypeOnly(n.declaration)) ||
      n.type === 'FunctionDeclaration' && !n.body;
  }
  function fnBody(fn) {
    const b = fn.body;
    if (!b) return; // overloads, abstract, declare
    if (b.type === 'BlockStatement' || b.type === 'FunctionBody') {
      let at = b.start + 1, dir = false;
      const body = b.body || [];
      for (const st of body) { if (st.type === 'ExpressionStatement' && st.directive) { at = st.end; dir = true; } else break; }
      const i = add(fn.start, fn.end, 'f');
      const prev = A;
      open(at, `;const ${L}=${ACC};${L}[${i}]=1;`);
      A = L;
      visitList(body, false);
      A = prev;
    } else { // expression-bodied arrow (uses the enclosing alias)
      const i = add(fn.start, fn.end, 'f');
      open(b.start, `(${A}[${i}]=1,`); close(b.end, ')');
      visit(b);
    }
  }
  function visitChildren(n) {
    for (const key in n) {
      if (key === 'type' || key === 'start' || key === 'end' || TYPE_KEYS.has(key)) continue;
      const v = n[key];
      if (v && typeof v === 'object') {
        if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') visit(c); }
        else if (typeof v.type === 'string') visit(v);
      }
    }
  }
  function visit(n) {
    if (isTypeOnly(n)) return;
    switch (n.type) {
      case 'Program': visitList(n.body, true); return;
      case 'ExpressionStatement':
        // the inline short-circuit marker opens with `((` – a statement starting with `(` would continue
        // the previous line without semicolon (ASI hazard) → lead with an empty statement
        if (!n.directive) open(n.start, ';');
        visit(n.expression); return;
      case 'BlockStatement': case 'StaticBlock': visitList(n.body, false); return;
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': {
        // parameter defaults of a hoisted declaration can run before the prelude → accessor
        const prev = A;
        if (n.type === 'FunctionDeclaration') A = ACC;
        for (const p of n.params) visit(p);
        A = prev;
        fnBody(n); return;
      }
      case 'IfStatement': {
        visit(n.test);
        const implicitElse = n.alternate ? '' : ` else {${mark(add(n.start, n.end, 'b'))}}`;
        // NB: implicit else index allocated first is fine – ids only need to be stable
        markStmt(n.consequent, 'b', n.consequent, implicitElse);
        visit(n.consequent);
        if (n.alternate) { markStmt(n.alternate, 'b'); visit(n.alternate); }
        return;
      }
      case 'SwitchStatement': {
        visit(n.discriminant);
        if (!n.cases.some((c) => c.test == null)) {
          const i = add(n.start, n.end, 'b');
          open(n.cases.length ? n.cases[0].start : n.end - 1, `default: ${mark(i)} break; `);
        }
        for (const c of n.cases) {
          if (c.test) visit(c.test);
          const i = add(c.start, c.end, 'b');
          const at = c.consequent.length ? c.consequent[0].start : c.end;
          open(at, mark(i));
          visitList(c.consequent, false);
        }
        return;
      }
      case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': case 'WhileStatement': case 'DoWhileStatement':
        for (const k of ['init', 'left', 'right', 'test', 'update']) if (n[k]) visit(n[k]);
        markStmt(n.body, 'b'); visit(n.body); return;
      case 'TryStatement':
        visit(n.block);
        if (n.handler) {
          if (n.handler.param) visit(n.handler.param);
          markStmt(n.handler.body, 'b', n.handler); visit(n.handler.body);
        }
        if (n.finalizer) { markStmt(n.finalizer, 'b'); visit(n.finalizer); }
        return;
      case 'ConditionalExpression':
        visit(n.test);
        wrapExpr(n.consequent, 'b'); visit(n.consequent);
        wrapExpr(n.alternate, 'b'); visit(n.alternate);
        return;
      case 'LogicalExpression': {
        // short-circuit taken → mark, value-preserving and call-free: ((t=LEFT)||(k[i]=1),t) for &&
        const i = add(n.left.start, n.left.end, 'b');
        const test = n.operator === '&&' ? `||(${A}[${i}]=1)` : n.operator === '||' ? `&&(${A}[${i}]=1)` : `!=null&&(${A}[${i}]=1)`;
        open(n.left.start, `((${T}=`); close(n.left.end, `)${test},${T})`);
        visit(n.left);
        wrapExpr(n.right, 'b'); visit(n.right);
        return;
      }
      case 'AssignmentExpression':
        visit(n.left);
        if ((n.operator === '&&=' || n.operator === '||=' || n.operator === '??=') && !anonFn(n.right)) wrapExpr(n.right, 'b');
        visit(n.right); return;
      case 'AssignmentPattern':
        visit(n.left); if (!anonFn(n.right)) wrapExpr(n.right, 'b'); visit(n.right); return;
      case 'PropertyDefinition': case 'AccessorProperty':
        if (n.declare || n.abstract) return;
        if (n.computed) visit(n.key);
        if (n.value) visit(n.value);
        return;
      case 'MethodDefinition': case 'TSAbstractMethodDefinition':
        if (n.computed) visit(n.key);
        if (n.value && n.value.body) visit(n.value);
        return;
      case 'TSEnumDeclaration': case 'TSModuleDeclaration': return;
      default: visitChildren(n);
    }
  }

  if (!hasIgnorePragma(code)) visit(res.program);
  // zero-block modules (constants, data, re-exports) are still registered → listed in fileload.modules
  // prelude after hashbang / directive prologue
  let at = 0;
  if (code.startsWith('#!')) at = code.indexOf('\n') + 1 || code.length;
  for (const st of res.program.body) { if (st.type === 'ExpressionStatement' && st.directive) at = st.end; else break; }
  const key = JSON.stringify(filename);
  const table = JSON.stringify(blocks);
  const th = createHash('sha1').update(table).digest('hex').slice(0, 12);
  // registry entry is reused only for the identical block table (vi.resetModules, isolate:false re-imports)
  // module self-evaluation time: Vite SSR hoists imports above this prelude, so prelude → end of
  // module is the module's own (exclusive) evaluation time
  const fh = sha256 ?? contentHash(code); // content hash of the original file on disk (DECISIONS.md D1, `file.sha256`)
  const prelude = `var ${P}t0=performance.now();var ${K};function ${I}(){var g=globalThis,r=g.__vto_reg||(g.__vto_reg=Object.create(null)),` +
    `f=g.__vto_fh||(g.__vto_fh=Object.create(null));f[${key}]="${fh}";var ` +
    `h=g.__vto_hash||(g.__vto_hash=Object.create(null));(g.__vto_blk||(g.__vto_blk=Object.create(null)))[${key}]=${JSON.stringify(table)};` +
    `var a=r[${key}];if(!a||h[${key}]!=="${th}"){a=r[${key}]=new Uint8Array(${blocks.length});h[${key}]="${th}"}return ${K}=a}${I}();` +
    `var ${T};`;
  s.appendLeft(at, (at ? '\n;' : '') + prelude + (at ? '' : '\n'));
  s.append(`\n;(globalThis.__vto_lt||(globalThis.__vto_lt=Object.create(null)))[${key}]=performance.now()-${P}t0;\n`);
  // pragma (first line, after a hashbang) – reliable "already instrumented" marker
  s.prependLeft(code.startsWith('#!') ? (code.indexOf('\n') + 1 || code.length) : 0, PRAGMA);
  return { code: s.toString(), map: sourceMap ? s.generateMap({ hires: 'boundary', source: filename, includeContent: true }) : null, blocks };
}

// plugin name carries a hash of this file: Vitest's fsModuleCache key includes plugin names,
// so cached instrumented modules are invalidated when the instrumentation changes and are
// never reused by plain (non-vto) runs.
const VERSION = createHash('sha1').update(readFileSync(new URL(import.meta.url))).update(readFileSync(new URL('./hash.mjs', import.meta.url))).digest('hex').slice(0, 10);
export const PLUGIN_NAME = 'vto:instrument';
// the "already instrumented" pragma carries a random per-process nonce: source text cannot spoof it (F14)
const PRAGMA = `/*@vto-instrumented:${randomBytes(8).toString('hex')}*/`;
const isInstrumented = (code) => code.startsWith(PRAGMA) || (code.startsWith('#!') && code.slice(code.indexOf('\n') + 1).startsWith(PRAGMA));

/**
 * The Vite/Vitest plugin. Options:
 *   excludeFiles – absolute paths never instrumented (in addition to test files / setupFiles)
 */
export default function vtoInstrument(opts = {}) {
  let vitest;
  // every path comparison goes through the canonical spelling (realpath, `/`, drive letter, NFC – D2):
  // Vite's module ids are real paths, configured paths (setupFiles, root through a symlink/junction/subst
  // drive, lower-case drive letter) need not be
  const exclude = new Set((opts.excludeFiles ?? []).map((f) => canonicalFile(f)));
  const setupCache = new WeakMap(); // setupFiles array → Set of canonical paths
  const isSetupFile = (p, canon) => {
    const list = p.config.setupFiles;
    let e = setupCache.get(list);
    if (!e || e.n !== list.length) { e = { n: list.length, set: new Set(list.map((f) => canonicalFile(f))) }; setupCache.set(list, e); }
    return e.set.has(canon);
  };
  const warned = new Set();
  // source maps are only needed for readable stack traces / snapshot locations; VTO_SOURCEMAP=0 skips them
  const needMap = process.env.VTO_SOURCEMAP !== '0';
  const isTestFile = (file) => {
    if (TEST_RE.test(file)) return true;
    if (vitest) {
      const canon = canonicalFile(file);
      for (const p of vitest.projects) {
        if (p.config.setupFiles.includes(file) || isSetupFile(p, canon)) return true;
        try { if (p.matchesTestGlob(file) || (canon !== file && p.matchesTestGlob(canon))) return true; } catch {}
      }
    }
    return false;
  };
  return {
    name: `${PLUGIN_NAME}@${VERSION}`,
    vto: { setVitest(v) { vitest = v; } },
    enforce: 'pre',
    configureVitest(ctx) { vitest = ctx.vitest; },
    // run before every other transform (React Compiler, auto-import, babel macros…): block
    // positions must be positions in the file on disk
    configResolved(config) {
      const i = config.plugins.findIndex((p) => p.name === this.name || p.name?.startsWith(PLUGIN_NAME));
      if (i > 0) { const [me] = config.plugins.splice(i, 1); config.plugins.unshift(me); }
      const rc = config.plugins.find((p) => /react-compiler|babel-plugin-react-compiler/.test(p.name ?? ''));
      if (rc) console.warn('vto: React Compiler detected – components are measured as written (uncompiled), the compiler skips instrumented components');
    },
    transform: {
      order: 'pre',
      handler(code, id) {
        if (id.charCodeAt(0) === 0 || id.startsWith('virtual:')) return;
        const file = id.split('?')[0];
        if (!EXT.test(file) || file.endsWith('.d.ts') || DIR_EXCLUDE.test(file) || !path.isAbsolute(file)) return;
        if ((exclude.size && exclude.has(canonicalFile(file))) || isTestFile(file)) return;
        if (isInstrumented(code)) return;
        // an earlier plugin already changed the code → positions would not match the source: skip
        let disk, bytes = null;
        try { bytes = readFileSync(file); disk = bytes.toString('utf8'); } catch { disk = null; }
        if (disk !== null && disk !== code && disk.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n') !== code.replace(/\r\n/g, '\n')) {
          if (!warned.has(file)) { warned.add(file); this.warn(`vto: ${file} was transformed by another plugin before vto – not instrumented`); }
          return;
        }
        let r;
        try { r = instrument(code, file, { sourceMap: needMap, sha256: bytes ? contentHash(bytes) : null }); } catch (e) { this.warn(`vto: cannot instrument ${file}: ${e.message}`); return; }
        if (!r) return;
        return { code: r.code, map: r.map };
      },
    },
  };
}
