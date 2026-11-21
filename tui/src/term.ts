// Terminal capabilities: colour level, Unicode, glyphs, theme. All decisions are made here from an
// injectable env/platform so they are unit-testable without a real terminal.
import chalk from 'chalk';

export type Env = Record<string, string | undefined>;

export interface TermCaps {
  /** 0 none, 1 = 16 colours, 2 = 256, 3 = truecolor */
  colorLevel: 0 | 1 | 2 | 3;
  unicode: boolean;
  /** emit SGR attributes (bold/reverse) at all – false for TERM=dumb and in snapshot tests */
  sgr?: boolean;
}

export function detectColorLevel(env: Env, isTTY: boolean, platform = process.platform): TermCaps['colorLevel'] {
  // https://no-color.org: any non-empty NO_COLOR disables colour (FORCE_COLOR wins only if explicitly set)
  if ('FORCE_COLOR' in env) {
    const f = env.FORCE_COLOR ?? '';
    if (f === '0' || f === 'false') return 0;
    if (/^[123]$/.test(f)) return Number(f) as 1 | 2 | 3;
    return detectColorLevel({ ...env, FORCE_COLOR: undefined, NO_COLOR: undefined }, true, platform) || 1;
  }
  if (env.NO_COLOR) return 0;
  if (!isTTY) return 0;
  if (env.TERM === 'dumb') return 0;
  const ct = (env.COLORTERM ?? '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 3;
  if (env.WT_SESSION) return 3; // Windows Terminal
  if (env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'vscode' || env.TERM_PROGRAM === 'WezTerm' || env.TERM_PROGRAM === 'ghostty') return 3;
  if (env.TERM_PROGRAM === 'Apple_Terminal') return 2; // Terminal.app: 256 only (truecolor since macOS 26 is not detectable)
  if (/-256(color)?$/i.test(env.TERM ?? '')) return 2;
  if (platform === 'win32') return 2; // conhost on Windows 10 1809+ handles 256 colours via VT
  return 1; // xterm, screen, linux console, … : basic 16 colours
}

/** Same heuristics as sindresorhus/is-unicode-supported + locale check on POSIX. */
export function detectUnicode(env: Env, platform = process.platform): boolean {
  if (env.VTO_ASCII === '1') return false;
  if (env.VTO_ASCII === '0') return true;
  if (platform !== 'win32') {
    if (env.TERM === 'linux') return false; // kernel console: limited glyphs
    const loc = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
    // LANG=C / POSIX / ISO-8859-2 → the terminal will most likely mangle box drawing
    if (loc && !/utf-?8/i.test(loc)) return false;
    return true;
  }
  return Boolean(
    env.WT_SESSION || env.TERMINUS_SUBLIME || env.ConEmuTask === '{cmd::Cmder}' ||
    env.TERM_PROGRAM === 'Terminus-Sublime' || env.TERM_PROGRAM === 'vscode' ||
    env.TERM === 'xterm-256color' || env.TERM === 'alacritty' || env.TERM === 'rxvt-unicode' ||
    env.TERMINAL_EMULATOR === 'JetBrains-JediTerm' || env.CI,
  );
}

export interface Glyphs {
  pass: string; fail: string; fixed: string; pending: string; skip: string; still: string;
  pointer: string; expand: string; collapse: string; barFull: string; barEmpty: string; barPartial: string[];
  sep: string; ellipsis: string; dot: string; arrowUp: string; arrowDown: string; vline: string; hline: string;
  spinner: string[]; border: 'round' | 'classic';
}

export const UNICODE_GLYPHS: Glyphs = {
  pass: '✓', fail: '✗', fixed: '✔', pending: '⟳', skip: '↓', still: '✗',
  pointer: '❯', expand: '▸', collapse: '▾', barFull: '█', barEmpty: '░', barPartial: ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'],
  sep: '│', ellipsis: '…', dot: '·', arrowUp: '↑', arrowDown: '↓', vline: '│', hline: '─',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], border: 'round',
};
export const ASCII_GLYPHS: Glyphs = {
  pass: '+', fail: 'x', fixed: 'v', pending: '~', skip: '-', still: 'x',
  pointer: '>', expand: '+', collapse: '-', barFull: '#', barEmpty: '.', barPartial: [''],
  sep: '|', ellipsis: '...', dot: '.', arrowUp: '^', arrowDown: 'v', vline: '|', hline: '-',
  spinner: ['-', '\\', '|', '/'], border: 'classic',
};

/** Theme colours in hex; chalk downsamples to 256/16 colours automatically per level. */
export const theme = {
  fail: '#ff5f6d',
  pass: '#3ddc84',
  fixed: '#3ddc84',
  pending: '#f5c542',
  skip: '#8a8f98',
  accent: '#7aa2f7',
  accent2: '#bb9af7',
  muted: '#7f8796',
  border: '#3b4252',
  borderFocus: '#7aa2f7',
  selBg: '#2a3350',
  expected: '#3ddc84',
  received: '#ff5f6d',
  // syntax-light
  kw: '#c678dd',
  str: '#98c379',
  num: '#d19a66',
  comment: '#6b7280',
  jsx: '#61afef',
  fn: '#e5c07b',
  gutter: '#5c6370',
  hiLineBg: '#3a2430',
};

/**
 * Terminals known to implement synchronized output (DEC mode 2026, which Ink 8 always emits):
 * there a full redraw cannot tear, and it is ~35 % cheaper in CPU than Ink's incremental line
 * diff. Elsewhere (Terminal.app, legacy conhost, xterm, linux console) incremental rendering
 * avoids flicker. Override: VTO_UI_REDRAW=full|incremental.
 */
export function prefersFullRedraw(env: Env): boolean {
  if (env.VTO_UI_REDRAW === 'full') return true;
  if (env.VTO_UI_REDRAW === 'incremental') return false;
  if (env.TMUX || (env.TERM ?? '').startsWith('screen')) return false; // multiplexers may not pass 2026 through
  return Boolean(
    env.WT_SESSION || env.KITTY_WINDOW_ID || env.WEZTERM_PANE || env.GHOSTTY_RESOURCES_DIR || env.ALACRITTY_WINDOW_ID ||
    ['iTerm.app', 'WezTerm', 'ghostty', 'vscode'].includes(env.TERM_PROGRAM ?? '') ||
    /^(xterm-kitty|foot|foot-extra|alacritty|xterm-ghostty|wezterm)$/.test(env.TERM ?? ''),
  );
}

let caps: TermCaps = { colorLevel: 0, unicode: true };

/** Apply caps globally (chalk is shared with Ink, so this also governs Ink's <Text color>). */
export function initTerm(c: TermCaps): void {
  caps = c;
  chalk.level = c.colorLevel;
}
export function getCaps(): TermCaps { return caps; }
export function glyphs(): Glyphs { return caps.unicode ? UNICODE_GLYPHS : ASCII_GLYPHS; }
/** Colour or undefined (Ink then renders without colour). With level 0 chalk strips anyway. */
export function c(color: keyof typeof theme): string | undefined { return caps.colorLevel ? theme[color] : undefined; }

/** Text progress bar with sub-cell precision when Unicode is available. */
export function bar(fraction: number, width: number): { full: string; empty: string } {
  const g = glyphs();
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const cells = f * width;
  let whole = Math.floor(cells);
  let part = '';
  if (g.barPartial.length > 1 && whole < width) {
    const idx = Math.floor((cells - whole) * g.barPartial.length);
    part = g.barPartial[idx] ?? '';
  }
  if (whole > width) whole = width;
  const emptyN = Math.max(0, width - whole - (part ? 1 : 0));
  return { full: g.barFull.repeat(whole) + part, empty: g.barEmpty.repeat(emptyN) };
}
