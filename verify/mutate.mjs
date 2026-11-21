// vto verify – mutant generation and mutant schemata (all mutants of a file in one module).
//
// generateMutants(code, file)  → [{ op, start, end, line, col, text, kind, desc, original }]
//   start/end   : original-source UTF-16 offsets of the replaced range (or of the statement/function
//                 that a statement-level mutant guards)
//   kind        : 'wrap'   – expression range replaced by `text` when active
//                 'skip'   – statement guarded by `if (!active)`
//                 'return' – `if (active) return;` inserted at function body start (`at`)
//                 'jsx'    – JSX text / attribute string replaced by `text` (already a JSX child/attr)
// applySchemata(code, file, mutants) → { code, map }  every mutant guarded by `globalThis.__vto_mut === id`
//
// Only code inside functions is mutated: module top-level code runs at import time, before any
// mutant can be activated, and (in v2 coverage) is never attributed to a test.
import { parseSync } from 'oxc-parser';
import MagicString from 'magic-string';

const TYPE_KEYS = new Set(['typeAnnotation', 'returnType', 'typeParameters', 'typeArguments',
  'superTypeArguments', 'superTypeParameters', 'implements', 'decorators']);
const TS_RUNTIME = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression',
  'TSTypeAssertion', 'TSInstantiationExpression', 'TSParameterProperty', 'TSExportAssignment']);
const FN = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const LOOP_TEST_PARENTS = new Set(['WhileStatement', 'DoWhileStatement', 'ForStatement']);
const SWAP = { '<': '<=', '<=': '<', '>': '>=', '>=': '>', '+': '-', '-': '+', '*': '/', '/': '*',
  '===': '!==', '!==': '===', '==': '!=', '!=': '==', '&&': '||', '||': '&&' };
const OP_NAME = { '<': 'boundary', '<=': 'boundary', '>': 'boundary', '>=': 'boundary', '+': 'arithmetic',
  '-': 'arithmetic', '*': 'arithmetic', '/': 'arithmetic', '===': 'equality', '!==': 'equality',
  '==': 'equality', '!=': 'equality', '&&': 'logical', '||': 'logical' };

const CMP = new Set(['<', '<=', '>', '>=', '===', '!==', '==', '!=']);
const DROP_METHODS = new Set(['trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase', 'filter', 'slice', 'sort', 'reverse']);
const SWAP_METHODS = { toLowerCase: 'toUpperCase', toUpperCase: 'toLowerCase', some: 'every', every: 'some',
  startsWith: 'endsWith', endsWith: 'startsWith', min: 'max', max: 'min', ceil: 'floor', floor: 'ceil', trimStart: 'trimEnd', trimEnd: 'trimStart' };
/** operator groups: the task's base set and the extension (Stryker/PIT-like + React-aware) */
export const OPS_SPEC = ['negate', 'logical', 'nullish', 'boundary', 'arithmetic', 'string', 'boolean', 'jsx-child', 'early-return', 'remove-call', 'optional-chain', 'equality'];
export const OPS_EXT = ['cond-const', 'constant', 'jsx-value', 'method'];

export const langOf = (f) => /\.[cm]?tsx$/.test(f) ? 'tsx' : /\.[cm]?ts$/.test(f) ? 'ts' : /\.[cm]?jsx$/.test(f) ? 'jsx' : 'js';

export function lineIndex(code) {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) starts.push(i + 1);
  return {
    pos(off) {
      let lo = 0, hi = starts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
      return [lo + 1, off - starts[lo]];
    },
    off(line, col) { return (starts[line - 1] ?? code.length) + col; },
  };
}

/** JSX text → the string React receives (Babel's cleanJSXElementLiteralChild). null = whitespace only. */
function jsxTextValue(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  let last = 0;
  for (let i = 0; i < lines.length; i++) if (/[^ \t]/.test(lines[i])) last = i;
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i].replace(/\t/g, ' ');
    if (i !== 0) l = l.replace(/^[ ]+/, '');
    if (i !== lines.length - 1) l = l.replace(/[ ]+$/, '');
    if (l) { if (i !== last) l += ' '; out += l; }
  }
  return out.length ? out : null;
}

export function parse(code, file) {
  const res = parseSync(file, code, { lang: langOf(file), sourceType: 'module', preserveParens: true });
  if (res.errors?.some((e) => e.severity === 'Error' || !e.severity)) return null;
  return res.program;
}

/**
 * Spans of v2 "pseudo blocks" whose hit means *a path was skipped* rather than *code ran*
 * (logical left operand = short-circuit taken, implicit else = whole if, implicit default = whole switch).
 * A mutant must never be attributed to them.
 */
export function pseudoSpans(program) {
  const out = new Set();
  walk(program, (n) => {
    if (n.type === 'LogicalExpression') out.add(`${n.left.start}:${n.left.end}`);
    else if (n.type === 'IfStatement' && !n.alternate) out.add(`${n.start}:${n.end}`);
    else if (n.type === 'SwitchStatement' && !n.cases.some((c) => c.test == null)) out.add(`${n.start}:${n.end}`);
  });
  return out;
}

function isTypeOnly(n) {
  return (n.type.startsWith('TS') && !TS_RUNTIME.has(n.type)) || n.declare === true ||
    ((n.type === 'ExportNamedDeclaration' || n.type === 'ImportDeclaration') && (n.exportKind === 'type' || n.importKind === 'type'));
}

function walk(n, enter, parent = null, key = null) {
  if (!n || typeof n.type !== 'string' || isTypeOnly(n)) return;
  if (enter(n, parent, key) === false) return;
  for (const k in n) {
    if (k === 'type' || k === 'start' || k === 'end' || TYPE_KEYS.has(k)) continue;
    const v = n[k];
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c, enter, n, k); }
      else if (typeof v.type === 'string') walk(v, enter, n, k);
    }
  }
}

export function generateMutants(code, file, program = parse(code, file)) {
  if (!program) return [];
  const idx = lineIndex(code);
  const src = (n) => code.slice(n.start, n.end);
  const muts = [];
  const add = (m) => {
    const [line, col] = idx.pos(m.start);
    muts.push({ ...m, line, col, original: code.slice(m.start, m.end).slice(0, 80) });
  };
  // replace a sub-range [a,b) of node n by `rep` → full mutated text of n
  const splice = (n, a, b, rep) => code.slice(n.start, a) + rep + code.slice(b, n.end);
  let fnDepth = 0;
  const parents = [];

  function visit(n, parent, key) {
    if (!n || typeof n.type !== 'string' || isTypeOnly(n)) return;
    const inFn = fnDepth > 0;
    if (inFn) mutateNode(n, parent, key);
    const isFn = FN.has(n.type);
    if (isFn) {
      fnDepth++;
      if (n.type === 'ArrowFunctionExpression' && n.expression && n.body) {
        let b = n.body;
        if (b.type === 'ParenthesizedExpression') b = b.expression;
        if (b.type === 'CallExpression' || b.type === 'ChainExpression')
          add({ op: 'remove-call', kind: 'wrap', start: n.body.start, end: n.body.end, text: 'undefined', desc: `remove call \`${src(b).slice(0, 40)}\`` });
      }
      if (n.body && (n.body.type === 'BlockStatement' || n.body.type === 'FunctionBody') && !n.generator) {
        let at = n.body.start + 1;
        for (const st of n.body.body || []) { if (st.type === 'ExpressionStatement' && st.directive) at = st.end; else break; }
        add({ op: 'early-return', kind: 'return', start: n.start, end: n.end, at, text: '',
          desc: 'early return at the start of the function' });
      }
    }
    parents.push(n);
    for (const k in n) {
      if (k === 'type' || k === 'start' || k === 'end' || TYPE_KEYS.has(k)) continue;
      const v = n[k];
      if (v && typeof v === 'object') {
        if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') visit(c, n, k); }
        else if (typeof v.type === 'string') visit(v, n, k);
      }
    }
    parents.pop();
    if (isFn) fnDepth--;
  }

  function lhsLike(parent, key) {
    return (parent?.type === 'AssignmentExpression' && key === 'left') || parent?.type === 'UpdateExpression' ||
      (parent?.type === 'UnaryExpression' && parent.operator === 'delete') ||
      (parent?.type === 'CallExpression' && key === 'callee') || (parent?.type === 'NewExpression' && key === 'callee') ||
      (parent?.type === 'TaggedTemplateExpression') || parent?.type === 'AssignmentPattern' && key === 'left' ||
      (parent?.type === 'ForInStatement' || parent?.type === 'ForOfStatement') && key === 'left';
  }

  function mutateNode(n, parent, key) {
    switch (n.type) {
      case 'BinaryExpression': {
        const rep = SWAP[n.operator];
        if (!rep) break;
        // operator token position: first occurrence of the operator between the operands
        const between = code.slice(n.left.end, n.right.start);
        const rel = between.indexOf(n.operator);
        if (rel < 0) break;
        const a = n.left.end + rel;
        add({ op: OP_NAME[n.operator], kind: 'wrap', start: n.start, end: n.end, text: splice(n, a, a + n.operator.length, rep),
          desc: `\`${n.operator}\` → \`${rep}\`` });
        if (CMP.has(n.operator)) {
          // condition → constant (Stryker "ConditionalExpression")
          // never `true` for a loop condition (would not terminate)
          if (!(key === 'test' && LOOP_TEST_PARENTS.has(parent?.type)))
            add({ op: 'cond-const', kind: 'wrap', start: n.start, end: n.end, text: 'true', desc: `\`${src(n).slice(0, 30)}\` → \`true\`` });
          add({ op: 'cond-const', kind: 'wrap', start: n.start, end: n.end, text: 'false', desc: `\`${src(n).slice(0, 30)}\` → \`false\`` });
          // boundary constant ±1 (PIT "inline constant") – separates on-point / off-point tests
          for (const side of ['left', 'right']) {
            const lit = n[side];
            if (lit.type === 'Literal' && typeof lit.value === 'number' && Number.isInteger(lit.value) && /[<>]/.test(n.operator)) {
              for (const d of [1, -1]) add({ op: 'constant', kind: 'wrap', start: lit.start, end: lit.end, text: String(lit.value + d),
                desc: `constant ${lit.value} → ${lit.value + d}` });
            }
          }
        }
        break;
      }
      case 'CallExpression': {
        // method expression (Stryker-like): x.trim() → x, toUpperCase ↔ toLowerCase, some ↔ every, Math.min ↔ max …
        const c = n.callee;
        if (c.type !== 'MemberExpression' || c.computed || c.property.type !== 'Identifier') break;
        const name = c.property.name;
        if (DROP_METHODS.has(name) && !n.optional && !c.optional) {
          add({ op: 'method', kind: 'wrap', start: n.start, end: n.end, text: `(${src(c.object)})`, desc: `\`.${name}(…)\` removed` });
        } else if (SWAP_METHODS[name] && !(c.object.type === 'Identifier' && c.object.name !== 'Math' && /^(min|max|ceil|floor)$/.test(name))) {
          const a = c.property.start;
          add({ op: 'method', kind: 'wrap', start: n.start, end: n.end, text: splice(n, a, c.property.end, SWAP_METHODS[name]),
            desc: `\`.${name}\` → \`.${SWAP_METHODS[name]}\`` });
        }
        break;
      }
      case 'LogicalExpression': {
        if (n.operator === '??') {
          add({ op: 'nullish', kind: 'wrap', start: n.start, end: n.end, text: `(${src(n.right)})`, desc: '`a ?? b` → `b`' });
        } else {
          const between = code.slice(n.left.end, n.right.start);
          const rel = between.indexOf(n.operator);
          if (rel >= 0) {
            const a = n.left.end + rel;
            add({ op: 'logical', kind: 'wrap', start: n.start, end: n.end, text: splice(n, a, a + 2, SWAP[n.operator]),
              desc: `\`${n.operator}\` → \`${SWAP[n.operator]}\`` });
          }
        }
        break;
      }
      case 'UnaryExpression':
        if (n.operator === '!' && !lhsLike(parent, key))
          add({ op: 'negate', kind: 'wrap', start: n.start, end: n.end, text: `(${src(n.argument)})`, desc: 'remove `!`' });
        break;
      case 'Literal': {
        if (lhsLike(parent, key)) break;
        if (parent?.type === 'ImportDeclaration' || parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ExportAllDeclaration' ||
          parent?.type === 'ImportExpression' || (parent?.type === 'Property' && key === 'key' && !parent.computed) ||
          (parent?.type === 'ExpressionStatement' && parent.directive) || parent?.type === 'TSLiteralType' ||
          (parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition') && key === 'key') break;
        if (typeof n.value === 'boolean') {
          add({ op: 'boolean', kind: 'wrap', start: n.start, end: n.end, text: String(!n.value), desc: `\`${n.value}\` → \`${!n.value}\`` });
        } else if (typeof n.value === 'string' && n.value.length) {
          if (parent?.type === 'JSXAttribute') {
            if (parent.name?.name === 'key') break;
            add({ op: 'string', kind: 'jsx', start: n.start, end: n.end, text: '{""}', expr: JSON.stringify(n.value), desc: `"${n.value.slice(0, 30)}" → ""` });
          } else add({ op: 'string', kind: 'wrap', start: n.start, end: n.end, text: '""', desc: `"${n.value.slice(0, 30)}" → ""` });
        }
        break;
      }
      case 'TemplateLiteral':
        if (parent?.type === 'TaggedTemplateExpression') break;
        add({ op: 'string', kind: 'wrap', start: n.start, end: n.end, text: '""', desc: 'template string → ""' });
        break;
      case 'JSXText': {
        const v = jsxTextValue(n.value);
        if (v == null || /[&{}<>]/.test(n.value)) break;
        add({ op: 'string', kind: 'jsx', start: n.start, end: n.end, text: '{""}', expr: JSON.stringify(v), desc: `JSX text "${v.slice(0, 30)}" → ""` });
        break;
      }
      case 'JSXExpressionContainer': {
        const e = n.expression;
        if (!e || e.type === 'JSXEmptyExpression') break;
        if (parent?.type === 'JSXElement' || parent?.type === 'JSXFragment') {
          if (e.type === 'LogicalExpression' || e.type === 'ConditionalExpression' ||
            (e.type === 'ParenthesizedExpression' && /Logical|Conditional/.test(e.expression.type)))
            add({ op: 'jsx-child', kind: 'wrap', start: e.start, end: e.end, text: 'false', desc: 'conditional JSX child → `{false}`' });
          else add({ op: 'jsx-value', kind: 'wrap', start: e.start, end: e.end, text: 'null', desc: `JSX child \`{${src(e).slice(0, 30)}}\` → \`{null}\`` });
        } else if (parent?.type === 'JSXAttribute' && parent.name?.name !== 'key' && parent.name?.name !== 'ref') {
          const an = parent.name.type === 'JSXNamespacedName' ? `${parent.name.namespace.name}:${parent.name.name.name}` : parent.name.name;
          add({ op: 'jsx-value', kind: 'wrap', start: e.start, end: e.end, text: 'undefined', desc: `attribute \`${an}\` → undefined` });
        }
        break;
      }
      case 'ChainExpression': {
        if (lhsLike(parent, key)) break;
        // remove every `?.` that belongs to this chain (not nested chains in arguments)
        const opt = [];
        const collect = (c) => {
          if (!c) return;
          if (c.type === 'MemberExpression') { if (c.optional) opt.push(c); collect(c.object); }
          else if (c.type === 'CallExpression') { if (c.optional) opt.push(c); collect(c.callee); }
          else if (c.type === 'TSNonNullExpression') collect(c.expression);
        };
        collect(n.expression);
        if (!opt.length) break;
        let text = src(n);
        // rebuild from right to left
        const edits = [];
        for (const c of opt) {
          const from = c.type === 'MemberExpression' ? c.object.end : c.callee.end;
          const to = c.type === 'MemberExpression' ? (c.computed ? c.property.start : c.property.start) : (c.arguments[0]?.start ?? c.end - 1);
          const seg = code.slice(from, to);
          const q = seg.indexOf('?.');
          if (q < 0) continue;
          const after = code.slice(from + q + 2, to).trimStart();
          const repl = c.type === 'MemberExpression' && !c.computed ? '.' : '';
          // `a?.[x]` → `a[x]`, `f?.()` → `f()`, `a?.b` → `a.b`
          edits.push([from + q, from + q + 2, after.startsWith('[') || after.startsWith('(') ? '' : repl]);
        }
        edits.sort((x, y) => y[0] - x[0]);
        for (const [a, b, r] of edits) text = text.slice(0, a - n.start) + r + text.slice(b - n.start);
        add({ op: 'optional-chain', kind: 'wrap', start: n.start, end: n.end, text, desc: 'remove `?.`' });
        break;
      }
      case 'ExpressionStatement': {
        let e = n.expression;
        if (e.type === 'AwaitExpression') e = e.argument;
        if (e.type === 'ChainExpression') e = e.expression;
        if (e.type === 'CallExpression' && parent && (parent.type === 'BlockStatement' || parent.type === 'FunctionBody' ||
          parent.type === 'SwitchCase' || parent.type === 'StaticBlock'))
          add({ op: 'remove-call', kind: 'skip', start: n.start, end: n.end, text: '', desc: `remove call \`${src(e).slice(0, 40)}\`` });
        break;
      }
      case 'ArrowFunctionExpression': break;
      default: break;
    }
    // conditions: negate tests of if / ternary (not loops: may never terminate)
    if (parent && key === 'test' && (parent.type === 'IfStatement' || parent.type === 'ConditionalExpression') && !LOOP_TEST_PARENTS.has(parent.type))
      add({ op: 'negate', kind: 'wrap', start: n.start, end: n.end, text: `!(${src(n)})`, desc: 'negate condition' });
  }

  // nested functions: top-level arrows/functions also counted via fnDepth in visit
  visit(program, null, null);
  // dedupe identical (start,end,text)
  const seen = new Set();
  return muts.filter((m) => {
    const k = `${m.kind}:${m.start}:${m.end}:${m.at ?? ''}:${m.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** One module containing every mutant, each behind `globalThis.__vto_mut === id`. */
export function applySchemata(code, file, mutants) {
  const s = new MagicString(code);
  const G = '__vto_m()';
  // outer ranges first (start asc, end desc); statement guards before expression wraps
  const order = { skip: 0, return: 1, wrap: 2, jsx: 3 };
  const ms = [...mutants].sort((a, b) => (a.start - b.start) || (b.end - a.end) || (order[a.kind] - order[b.kind]) || (a.id - b.id));
  for (const m of ms) {
    if (m.kind === 'wrap') {
      s.appendRight(m.start, `(${G}===${m.id}?(${m.text}):`);
      s.prependLeft(m.end, ')');
    } else if (m.kind === 'skip') {
      s.appendRight(m.start, `if(${G}!==${m.id})`);
    } else if (m.kind === 'return') {
      s.appendRight(m.at, `if(${G}===${m.id})return;`);
    }
  }
  // JSX text / attribute strings: the original must stay valid JSX → overwrite whole node per file,
  // combining every jsx-mutant on the same node into one expression container.
  const byNode = new Map();
  for (const m of ms) if (m.kind === 'jsx') {
    const k = `${m.start}:${m.end}`;
    if (!byNode.has(k)) byNode.set(k, []);
    byNode.get(k).push(m);
  }
  for (const list of byNode.values()) {
    const { start, end, expr } = list[0];
    const isAttr = code[start] === '"' || code[start] === "'";
    let e = expr;
    for (const m of list) e = `${G}===${m.id}?"":${e}`;
    // keep leading/trailing whitespace of JSX text (it may matter); value already normalised
    s.overwrite(start, end, isAttr ? `{${e}}` : `{${e}}`);
  }
  let at = 0;
  if (code.startsWith('#!')) at = code.indexOf('\n') + 1;
  s.appendLeft(at, 'function __vto_m(){return globalThis.__vto_mut|0}\n');
  return { code: s.toString(), map: s.generateMap({ hires: 'boundary', source: file, includeContent: true }) };
}
