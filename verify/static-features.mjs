// vto cheap signal – static test-body features from an oxc parse of the test files (no test run).
// staticFeatures(testFile) → Map(fullName → { asserts:Set, actions:Set })
//   asserts: normalised source of each `expect(…)…matcher(…)` chain (subject + matcher + args)
//   actions: normalised source of every other call in the body (render(<X a=1/>), fireEvent.click(…),
//            userEvent.*, act(…), helper calls) – i.e. the scenario
//   skeleton: the body's AST with every literal, JSX text and data path (member chain rooted at an import of a
//            data file – .json/.yaml/.csv/?raw/fixtures) replaced by a placeholder; data: those values in order.
//            Two tests with equal skeletons but different data are data-driven variants: code mutants cannot
//            distinguish them, so verify never confirms such a pair (dataDriven()). A unary chain over a literal
//            (`-1`, `!0`, `void 0`) and `undefined`/`NaN`/`Infinity` count as literals.
//   calls:   callee → set of argument lists, for inputsDiffer(): A calls f with arguments B never uses.
// Pair (A, B) passes the static check when asserts(A) ⊆ asserts(B) and actions(A) ⊆ actions(B).
import { readFileSync } from 'node:fs';
import { parseSync } from 'oxc-parser';

const TEST_FNS = new Set(['it', 'test']);
const SUITE_FNS = new Set(['describe', 'suite']);
const MODIFIERS = new Set(['only', 'skip', 'concurrent', 'sequential', 'fails', 'todo']);
const norm = (s) => s.replace(/\s+/g, '').replace(/;$/, '');

const VALUE_IDS = new Set(['undefined', 'NaN', 'Infinity']);
/** Source text of a unary chain over a literal (`-1`, `!true`, `void 0`, `-Infinity`), else null. */
function foldedLiteral(n) {
  let sign = '';
  while (n && n.type === 'UnaryExpression' && ['-', '+', '!', '~', 'void'].includes(n.operator)) {
    sign += n.operator === 'void' ? 'void ' : n.operator;
    n = n.argument;
  }
  if (!n) return null;
  if (n.type === 'Literal') return sign + (n.raw ?? String(n.value));
  if (n.type === 'Identifier' && VALUE_IDS.has(n.name)) return sign + n.name;
  return null;
}

function calleeName(c) {
  // it / it.only / test.concurrent / describe.skip / it.each([...]) (not supported → null)
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && MODIFIERS.has(c.property.name)) return c.object.name;
  return null;
}
const strOf = (n) => n && (n.type === 'Literal' && typeof n.value === 'string' ? n.value
  : n.type === 'TemplateLiteral' && !n.expressions.length ? n.quasis[0].value.cooked : null);

function isExpectChain(n) {
  // matcher call whose object chain bottoms out in expect(...)
  for (let c = n; c; ) {
    if (c.type === 'CallExpression') { if (c.callee.type === 'Identifier' && c.callee.name === 'expect') return true; c = c.callee; }
    else if (c.type === 'MemberExpression') c = c.object;
    else if (c.type === 'AwaitExpression') c = c.argument;
    else return false;
  }
  return false;
}

export function staticFeatures(file, code = readFileSync(file, 'utf8')) {
  const lang = /\.tsx$/.test(file) ? 'tsx' : /\.ts$/.test(file) ? 'ts' : /\.jsx$/.test(file) ? 'jsx' : 'js';
  const { program } = parseSync(file, code, { lang, sourceType: 'module' });
  const out = new Map();
  const src = (n) => code.slice(n.start, n.end);

  // identifiers bound to data imports
  const dataIds = new Set();
  const DATA_SRC = /\.(json5?|ya?ml|csv|txt|md)(\?.*)?$|[?&]raw\b|\/(__)?fixtures?(__)?\/|\/data\//;
  for (const st of program.body) if (st.type === 'ImportDeclaration' && DATA_SRC.test(st.source.value))
    for (const sp of st.specifiers) dataIds.add(sp.local.name);
  const rootIdent = (n) => { while (n && (n.type === 'MemberExpression' || n.type === 'ChainExpression')) n = n.object ?? n.expression; return n?.type === 'Identifier' ? n.name : null; };
  function skeletonOf(body) {
    const data = [];
    const ser = (n) => {
      if (n === null || n === undefined) return '_';
      if (Array.isArray(n)) return `[${n.map(ser).join(',')}]`;
      if (typeof n !== 'object' || typeof n.type !== 'string') return '_';
      switch (n.type) {
        case 'Literal': data.push(n.raw ?? String(n.value)); return 'L';
        // a signed / negated literal is still one literal: `-1234.5`, `+1`, `!0`, `~0`, `void 0`, `- -1`
        // (C-M8: `f(1234.5)` and `f(-1234.5)` are data variants of the same test)
        case 'UnaryExpression': { const lit = foldedLiteral(n); if (lit !== null) { data.push(lit); return 'L'; } break; }
        case 'TemplateLiteral': if (!n.expressions.length) { data.push(n.quasis[0].value.raw); return 'L'; } break;
        case 'TemplateElement': if (n.value.raw) { data.push(n.value.raw); return 'L'; } return '';
        case 'JSXText': if (n.value.trim()) { data.push(n.value.trim()); return 'L'; } return '';
        case 'MemberExpression': case 'ChainExpression': {
          const r = rootIdent(n);
          if (r && dataIds.has(r)) { data.push(norm(src(n))); return 'D'; }
          break;
        }
        case 'Identifier':
          if (dataIds.has(n.name)) { data.push(n.name); return 'D'; }
          if (VALUE_IDS.has(n.name)) { data.push(n.name); return 'L'; } // undefined / NaN / Infinity are values, not names
          return `#${n.name}`;
        case 'JSXIdentifier': return `#${n.name}`;
      }
      let out = n.type;
      if (n.operator) out += n.operator;
      if (n.computed) out += '[]';
      if (n.optional) out += '?';
      out += '(';
      for (const k in n) {
        if (k === 'type' || k === 'start' || k === 'end' || k === 'range' || k === 'loc' || k === 'operator' || k === 'raw' ||
          k === 'computed' || k === 'optional') continue;
        const v = n[k];
        if (v && typeof v === 'object') out += `${k}:${ser(v)};`;
        else if (typeof v === 'boolean' && v) out += `${k};`;
      }
      return out + ')';
    };
    return { skeleton: ser(body), data };
  }

  // every call of the body (also inside expect(…) and nested): callee → set of argument lists.
  // Function arguments are replaced by a placeholder (their own calls are collected separately).
  function callsOf(body) {
    const calls = new Map();
    const argText = (a) => (/Function/.test(a.type) ? 'ƒ' : norm(src(a)));
    const visit = (n) => {
      if (!n || typeof n.type !== 'string') return;
      if (n.type === 'CallExpression' || n.type === 'NewExpression') {
        const key = calleeKey(n.callee);
        if (key) {
          if (!calls.has(key)) calls.set(key, new Set());
          calls.get(key).add(n.arguments.map(argText).join(','));
        }
      }
      for (const k in n) {
        if (k === 'type' || k === 'start' || k === 'end') continue;
        const v = n[k];
        if (v && typeof v === 'object') { if (Array.isArray(v)) v.forEach(visit); else visit(v); }
      }
    };
    visit(body);
    return calls;
  }
  // callee without the arguments of calls inside it: `expect(f(1)).toBe` → `expect().toBe`, so the
  // matcher is compared per matcher name and its subject is compared as the `expect` call itself
  function calleeKey(c) {
    switch (c.type) {
      case 'Identifier': return c.name;
      case 'ThisExpression': return 'this';
      case 'Super': return 'super';
      case 'MemberExpression': { const o = calleeKey(c.object); return o === null ? null : c.computed ? `${o}[${norm(src(c.property))}]` : `${o}.${c.property.name}`; }
      case 'ChainExpression': return calleeKey(c.expression);
      case 'CallExpression': { const o = calleeKey(c.callee); return o === null ? null : `${o}()`; }
      case 'AwaitExpression': case 'TSNonNullExpression': case 'ParenthesizedExpression': return calleeKey(c.argument ?? c.expression);
      default: return null;
    }
  }

  function features(fn) {
    const asserts = new Set(), actions = new Set();
    const visit = (n) => {
      if (!n || typeof n.type !== 'string') return;
      if (n.type === 'CallExpression') {
        if (isExpectChain(n) && !(n.callee.type === 'Identifier' && n.callee.name === 'expect')) {
          asserts.add(norm(src(n)));
          return; // calls inside the assertion belong to it
        }
        if (!(n.callee.type === 'Identifier' && n.callee.name === 'expect')) {
          const name = norm(src(n.callee));
          // waitFor(() => expect(…)) → the expects are assertions, the wrapper is an action without args
          if (/^(waitFor|act)$/.test(name)) actions.add(name);
          else actions.add(norm(src(n)));
        }
      }
      for (const k in n) {
        if (k === 'type' || k === 'start' || k === 'end') continue;
        const v = n[k];
        if (v && typeof v === 'object') {
          if (Array.isArray(v)) v.forEach(visit);
          else visit(v);
        }
      }
    };
    visit(fn.body);
    return { asserts, actions, calls: callsOf(fn.body), ...skeletonOf(fn.body) };
  }

  function walk(n, chain) {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'CallExpression') {
      const name = calleeName(n.callee);
      const title = strOf(n.arguments[0]);
      const fn = n.arguments[1];
      if (name && title != null && fn && /Function/.test(fn.type)) {
        if (TEST_FNS.has(name)) { out.set([...chain, title].join(' > '), features(fn)); return; }
        if (SUITE_FNS.has(name)) { walk(fn.body, [...chain, title]); return; }
      }
    }
    for (const k in n) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (v && typeof v === 'object') {
        if (Array.isArray(v)) v.forEach((c) => walk(c, chain));
        else walk(v, chain);
      }
    }
  }
  walk(program, []);
  return out;
}

export const staticSubset = (a, b) => [...a.asserts].every((x) => b.asserts.has(x)) && [...a.actions].every((x) => b.actions.has(x));

/** null, or a short description of the data that differs when the two tests are data-driven variants */
export function dataDriven(a, b) {
  if (!a || !b || a.skeleton !== b.skeleton) return null;
  const diff = [];
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) diff.push(`${a.data[i]} ≠ ${b.data[i]}`);
  return diff.length ? diff.slice(0, 3).join(', ') + (diff.length > 3 ? ', …' : '') : null;
}

/**
 * null, or a short description of calls that test A makes with arguments test B never uses for
 * the same callee (`formatPrice(-1234.5)` vs `formatPrice(1234.5)`, `render(<X disabled/>)` vs
 * `render(<X/>)`). Such an A exercises an input B does not – code mutants cannot confirm that A is
 * redundant (branch-free code computes every partition with the same statements).
 */
export function inputsDiffer(a, b) {
  if (!a?.calls || !b?.calls) return null;
  const diff = [];
  for (const [callee, argsA] of a.calls) {
    const argsB = b.calls.get(callee);
    if (!argsB) continue; // a callee only A uses is an action/assertion difference – mutation can see that
    for (const args of argsA) if (!argsB.has(args)) { diff.push(`${callee}(${args.length > 40 ? args.slice(0, 40) + '…' : args})`); break; }
  }
  return diff.length ? diff.slice(0, 3).join(', ') + (diff.length > 3 ? ', …' : '') : null;
}
