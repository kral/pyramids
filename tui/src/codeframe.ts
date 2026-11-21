// Code frames read from disk + syntax-light highlighting for TS/TSX/JS (one-line tokenizer:
// good enough for a 7-line frame, no parser dependency, ~µs per line).
import fs from 'node:fs';
import type { theme } from './term.js';
import { resolveInsideRoot } from './safePath.js';
import { cleanLine } from './sanitize.js';

export interface Token { text: string; color?: keyof typeof theme }
export interface FrameLine { no: number; tokens: Token[]; highlight: boolean }
export interface CodeFrame { file: string; line: number; col?: number; lines: FrameLine[]; fromDisk: boolean }

const KEYWORDS = new Set(('const let var function return if else for while do switch case break continue new delete typeof instanceof ' +
  'in of class extends super this import export from default as async await yield try catch finally throw void null undefined ' +
  'true false interface type enum implements private public protected readonly static declare namespace keyof satisfies').split(' '));

const TOKEN_RE = /(\/\/.*$)|(\/\*.*?(?:\*\/|$))|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?n?\b|\b0x[\da-f]+\b)|(<\/?[A-Za-z][\w.]*|\/?>)|([A-Za-z_$][\w$]*)/gi;

export function highlightLine(src: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(src))) {
    if (m.index > last) out.push({ text: src.slice(last, m.index) });
    const [all, lc, bc, s, n, jsx, id] = m;
    if (lc || bc) out.push({ text: all, color: 'comment' });
    else if (s) out.push({ text: all, color: 'str' });
    else if (n) out.push({ text: all, color: 'num' });
    else if (jsx) out.push({ text: all, color: 'jsx' });
    else if (id) {
      if (KEYWORDS.has(id)) out.push({ text: all, color: 'kw' });
      else if (src[m.index + all.length] === '(') out.push({ text: all, color: 'fn' });
      else out.push({ text: all });
    }
    last = m.index + all.length;
    if (all.length === 0) TOKEN_RE.lastIndex++;
  }
  if (last < src.length) out.push({ text: src.slice(last) });
  return out;
}

/** Tiny LRU of file contents (split lines). Invalidated by mtime so fixes show up immediately. */
export class SourceCache {
  private map = new Map<string, { mtimeMs: number; lines: string[] }>();
  constructor(private root: string, private max = 64) {}
  /** Real path of `file` when it is a regular file inside the project root, else null. */
  resolve(file: string): string | null {
    const r = resolveInsideRoot(this.root, file);
    return r.ok ? r.abs : null;
  }
  /**
   * Lines of a project file, sanitised (a source file is as untrusted as test output: it can hold
   * raw ESC bytes). Frame paths outside the root – `/etc/passwd`, `../../.ssh/id_rsa`, a symlink
   * pointing out – are never read, so they cannot end up in the details pane or in an AI prompt.
   */
  lines(file: string): string[] | null {
    const r = resolveInsideRoot(this.root, file);
    if (!r.ok || r.size > 4 * 1024 * 1024) return null;
    const abs = r.abs;
    const hit = this.map.get(abs);
    if (hit && hit.mtimeMs === r.mtimeMs) { this.map.delete(abs); this.map.set(abs, hit); return hit.lines; }
    let text: string;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { return null; }
    const lines = text.replace(/^\ufeff/, '').split(/\r?\n/).map((l) => cleanLine(l, 2000));
    this.map.set(abs, { mtimeMs: r.mtimeMs, lines });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
    return lines;
  }
}

function expandTabs(s: string): string { return s.replace(/\t/g, '  '); }

export function codeFrame(cache: SourceCache, file: string, line: number, col?: number, fallbackCode?: string, context = 2): CodeFrame {
  const lines = cache.lines(file);
  if (!lines || line < 1 || line > lines.length) {
    return {
      file, line, col, fromDisk: false,
      lines: fallbackCode !== undefined ? [{ no: line, tokens: highlightLine(expandTabs(fallbackCode)), highlight: true }] : [],
    };
  }
  const from = Math.max(1, line - context);
  const to = Math.min(lines.length, line + context);
  const out: FrameLine[] = [];
  for (let n = from; n <= to; n++) out.push({ no: n, tokens: highlightLine(expandTabs(lines[n - 1])), highlight: n === line });
  return { file, line, col, lines: out, fromDisk: true };
}

/** Plain-text frame (for prompts / CI). */
export function codeFrameText(fr: CodeFrame, pointer = '>'): string {
  const w = String(fr.lines.at(-1)?.no ?? fr.line).length;
  const rows: string[] = [];
  for (const l of fr.lines) {
    rows.push(`${l.highlight ? pointer : ' '} ${String(l.no).padStart(w)} | ${l.tokens.map((t) => t.text).join('')}`);
    if (l.highlight && fr.col && fr.col > 0) rows.push(`  ${' '.repeat(w)} | ${' '.repeat(fr.col - 1)}^`);
  }
  return rows.join('\n');
}
