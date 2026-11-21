// A rendered line = list of styled segments. Building lines is pure (testable, cacheable);
// <SegLine> turns them into Ink <Text>.
import chalk, { type ChalkInstance } from 'chalk';
import sw from 'string-width';
import { getCaps, theme } from '../term.js';

/** string-width with an ASCII fast path and a cache (string-width itself uses Intl.Segmenter: slow per call). */
const widthCache = new Map<string, number>();
// eslint-disable-next-line no-control-regex
const ASCII = /^[\x20-\x7e]*$/;
export function stringWidth(text: string): number {
  if (ASCII.test(text)) return text.length;
  let w = widthCache.get(text);
  if (w === undefined) {
    w = sw(text);
    if (widthCache.size > 20_000) widthCache.clear();
    widthCache.set(text, w);
  }
  return w;
}

export type ThemeKey = keyof typeof theme;
export interface Seg { text: string; color?: ThemeKey; bg?: ThemeKey; bold?: boolean; dim?: boolean; inverse?: boolean; underline?: boolean }
export type SegLineT = Seg[];

export const s = (text: string, color?: ThemeKey, extra: Partial<Seg> = {}): Seg => ({ text, color, ...extra });

export function lineWidth(l: SegLineT): number { let w = 0; for (const x of l) w += stringWidth(x.text); return w; }
export function plain(l: SegLineT): string { return l.map((x) => x.text).join(''); }

/** Hard-wrap plain text to `width` columns (CJK/emoji aware), keeping an indent on continuation lines. */
export function wrapPlain(text: string, width: number, indent = ''): string[] {
  const out: string[] = [];
  const max = Math.max(4, width);
  for (const para of text.replace(/\r\n?/g, '\n').split('\n')) {
    let cur = '', w = 0, first = true;
    const lim = () => (first ? max : max - indent.length);
    for (const word of para.split(/(\s+)/)) {
      const ww = stringWidth(word);
      if (w + ww <= lim()) { cur += word; w += ww; continue; }
      if (cur.trim()) { out.push(first ? cur : indent + cur); first = false; cur = ''; w = 0; }
      if (/^\s+$/.test(word)) continue;
      // word longer than a line: split by characters
      let piece = '';
      for (const ch of word) {
        const cw = stringWidth(ch);
        if (stringWidth(piece) + cw > lim()) { out.push(first ? piece : indent + piece); first = false; piece = ''; }
        piece += ch;
      }
      cur = piece; w = stringWidth(piece);
    }
    out.push(first ? cur : indent + cur);
  }
  return out;
}

/** Truncate a segment line to `width` columns, appending an ellipsis. */
export function truncateLine(l: SegLineT, width: number, ellipsis: string): SegLineT {
  if (lineWidth(l) <= width) return l;
  const out: SegLineT = [];
  let w = 0;
  const limit = Math.max(0, width - stringWidth(ellipsis));
  for (const seg of l) {
    const sw = stringWidth(seg.text);
    if (w + sw <= limit) { out.push(seg); w += sw; continue; }
    let t = '';
    for (const ch of seg.text) { const cw = stringWidth(ch); if (w + cw > limit) break; t += ch; w += cw; }
    if (t) out.push({ ...seg, text: t });
    out.push({ text: ellipsis, color: 'muted' });
    break;
  }
  return out;
}

/**
 * Styled line → one ANSI string (one <Text> node per line instead of one per segment: ~10× less
 * React/Ink work; unchanged lines compare equal so React skips them). Cached by content.
 */
const ansiCache = new Map<string, string>();
export function toAnsi(l: SegLineT): string {
  const level = getCaps().colorLevel;
  const key = level + JSON.stringify(l);
  const hit = ansiCache.get(key);
  if (hit !== undefined) return hit;
  let out = '';
  for (const x of l) {
    if (!x.text) continue;
    let st: ChalkInstance = chalk;
    let styled = false;
    if (x.color && level) { st = st.hex(theme[x.color]); styled = true; }
    if (x.bg !== undefined) {
      if (level >= 2) st = st.bgHex(theme[x.bg]);
      else st = st.inverse; // 16 colours / no colour: selection as reverse video
      styled = true;
    }
    if (x.inverse) { st = st.inverse; styled = true; }
    if (x.bold) { st = st.bold; styled = true; }
    if (x.dim) { st = st.dim; styled = true; }
    if (x.underline) { st = st.underline; styled = true; }
    if (!level && getCaps().sgr !== false) {
      // NO_COLOR forbids colour, not emphasis: keep bold / reverse video (selection) by hand
      const inv = x.inverse || x.bg !== undefined;
      out += (x.bold ? '\x1b[1m' : '') + (inv ? '\x1b[7m' : '') + x.text + (inv ? '\x1b[27m' : '') + (x.bold ? '\x1b[22m' : '');
      continue;
    }
    out += styled ? st(x.text) : x.text;
  }
  if (ansiCache.size > 5000) ansiCache.clear();
  ansiCache.set(key, out);
  return out;
}

export function padLine(l: SegLineT, width: number, bg?: ThemeKey): SegLineT {
  const w = lineWidth(l);
  return w >= width ? l : [...l, { text: ' '.repeat(width - w), bg }];
}
