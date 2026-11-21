// DELIBERATELY BROKEN toy instrumenter, used only to prove that run.mjs catches real bug classes.
// It is NOT a reference implementation. Bugs can be toggled with TOY_BUGS (comma list, default all):
//   callee     naive comma-wrapping of call callees `(__vto_k[i]=1, obj.m)()` -> loses `this`, changes error messages
//   directive  inserts the function-body marker before the directive prologue
//   nobrace    inserts `marker;` before a non-block if/else/loop body without adding braces
//   label      inserts statement markers between a label and its statement
//   const      registry array declared with `const` after imports -> TDZ in import cycles
//   top        preamble inserted at offset 0 (before a hashbang)
//   bytes      columns recorded as UTF-8 byte offsets instead of UTF-16 units
//   cover      marks the alternate of every if as hit together with the consequent
// e.g. TOY_BUGS=callee node run.mjs --plugin toy-broken-plugin.mjs
import { parseSync } from 'oxc-parser';
import MagicString from 'magic-string';

const BUGS = new Set((process.env.TOY_BUGS ?? 'callee,directive,nobrace,label,const,top,bytes,cover').split(',').filter(Boolean));

export default function toyBroken() {
  let root = process.cwd();
  return {
    name: 'vto-toy-broken',
    enforce: 'pre',
    configResolved(c) { root = c.root; },
    transform(code, id) {
      const file = id.replace(/[?#].*$/, '');
      if (!file.startsWith(root) || file.includes('/node_modules/') || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || id.startsWith('\0')) return null;
      if (!/\.(m?[jt]sx?)$/.test(file)) return null;
      const lang = file.endsWith('x') ? (file.endsWith('.tsx') ? 'tsx' : 'jsx') : file.endsWith('.js') || file.endsWith('.mjs') ? 'js' : 'ts';
      const ast = parseSync(file, code, { lang, sourceType: 'module' });
      if (ast.errors.length) return null;
      const s = new MagicString(code);
      const blocks = [];
      const ls = [0];
      for (let i = 0; i < code.length; i++) if (code[i] === '\n') ls.push(i + 1);
      const lc = (o) => {
        let l = 0;
        while (l + 1 < ls.length && ls[l + 1] <= o) l++;
        const col = BUGS.has('bytes') ? Buffer.byteLength(code.slice(ls[l], o)) : o - ls[l];
        return [l + 1, col];
      };
      const block = (start, end, kind) => {
        blocks.push([...lc(start), ...lc(end), kind]);
        return blocks.length - 1;
      };
      const mark = (i) => `__vto_k[${i}]=1;`;
      const wrap = (n, kind = 'b') => {
        const i = block(n.start, n.end, kind);
        s.appendLeft(n.start, `(__vto_k[${i}]=1, `);
        s.prependRight(n.end, ')');
        return i;
      };
      const stmtBody = (b, kind = 'b') => {
        if (!b) return;
        const i = block(b.start, b.end, kind);
        if (b.type === 'BlockStatement') s.appendLeft(b.start + 1, mark(i));
        else if (BUGS.has('nobrace')) s.appendLeft(b.start, mark(i));
        else { s.appendLeft(b.start, `{${mark(i)}`); s.prependRight(b.end, '}'); }
        return i;
      };
      const visit = (n, parent) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { for (const x of n) visit(x, parent); return; }
        if (typeof n.type !== 'string') return;
        if (n.type.startsWith('TS') && n.type !== 'TSAsExpression' && n.type !== 'TSSatisfiesExpression' && n.type !== 'TSNonNullExpression' && n.type !== 'TSModuleDeclaration' && n.type !== 'TSModuleBlock') return;
        if (n.declare) return;
        switch (n.type) {
          case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': {
            if (!n.body) break;
            for (const p of n.params ?? []) if (p.type === 'AssignmentPattern') wrap(p.right);
            if (n.body.type === 'BlockStatement' || n.body.type === 'FunctionBody') {
              const i = block(n.body.start, n.body.end, 'f');
              let at = n.body.start + 1;
              if (!BUGS.has('directive')) for (const st of n.body.body) { if (st.directive !== undefined && st.directive !== null) at = st.end; else break; }
              s.appendLeft(at, mark(i));
            } else wrap(n.body, 'f');
            visit(n.params, n); visit(n.body, n);
            return;
          }
          case 'IfStatement': {
            visit(n.test, n);
            const ci = stmtBody(n.consequent);
            if (n.alternate) {
              const ai = stmtBody(n.alternate);
              if (BUGS.has('cover') && n.consequent.type === 'BlockStatement') s.appendLeft(n.consequent.start + 1, mark(ai));
            }
            void ci;
            visit(n.consequent, n); visit(n.alternate, n);
            return;
          }
          case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': case 'WhileStatement': case 'DoWhileStatement':
            stmtBody(n.body);
            break;
          case 'LabeledStatement':
            if (BUGS.has('label')) s.appendLeft(n.body.start, mark(block(n.body.start, n.body.end, 's')));
            break;
          case 'SwitchCase':
            if (n.consequent.length) s.appendLeft(n.consequent[0].start, mark(block(n.consequent[0].start, n.consequent.at(-1).end, 'b')));
            break;
          case 'CatchClause': stmtBody(n.body); break;
          case 'TryStatement': if (n.finalizer) stmtBody(n.finalizer); break;
          case 'ConditionalExpression': wrap(n.consequent); wrap(n.alternate); break;
          case 'LogicalExpression': wrap(n.right); break;
          case 'CallExpression':
            if (BUGS.has('callee') && n.callee.type === 'MemberExpression' && n.callee.object.type !== 'Super') wrap(n.callee, 's');
            break;
        }
        for (const k in n) if (k !== 'type' && n[k] && typeof n[k] === 'object') visit(n[k], n);
      };
      visit(ast.program.body, ast.program);
      if (!blocks.length) return null;
      const decl = BUGS.has('const') ? 'const' : 'var';
      const pre = `${decl} __vto_k = new Uint8Array(${blocks.length});(globalThis.__vto_reg ??= {})[${JSON.stringify(file)}] = __vto_k;(globalThis.__vto_blocks ??= {})[${JSON.stringify(file)}] = ${JSON.stringify(blocks)};\n`;
      let at = 0;
      if (!BUGS.has('top') && code.startsWith('#!')) at = code.indexOf('\n') + 1;
      s.prependLeft(at, pre);
      return { code: s.toString(), map: s.generateMap({ hires: true, source: file }) };
    },
  };
}
