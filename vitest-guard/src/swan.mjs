// A small ASCII swan that glides on rippling water while a long operation runs.
// Shown only on an interactive terminal (stderr), after a short delay so quick operations never flash it.
// Off in CI, when stderr is not a TTY, with TERM=dumb, or with VTO_NO_ANIMATION=1. Colour follows NO_COLOR/FORCE_COLOR.
import { colorEnabled } from './ui.mjs';

// the vto logo as ASCII: arched head, S-shaped neck, body rising to the right, the arc of water below;
// the whole logo rides on generated waves
const SWAN = [
  '   .-.            ',
  '  /   \\           ',
  '      /           ',
  "     /         _.-'",
  "    (     _.-'    ",
  "     `--'         ",
  "   `-.________.-'  ",   // the arc of water from the logo: part of the swan, it bobs with it
];
const SW = Math.max(...SWAN.map((r) => r.length));
const WIDTH = 44;
const MIN_WIDTH = 26;      // narrowest water the swan still fits on
const MIN_COLUMNS = 50;    // below this (or fewer than HEIGHT + 2 rows) only a one-line status is shown
const HEIGHT = SWAN.length + 2; // one row of bobbing room + two rows of water (the logo's arc can sit on the crests)

/** water height 0..1 per column at time t: a slow swell, groups of big and small waves, fine ripples */
export function surface(t, w = WIDTH) {
  const h = [];
  for (let x = 0; x < w; x++) {
    const swell = Math.sin(x * 0.11 - t * 0.06);
    const amp = 0.55 + 0.45 * Math.sin(x * 0.05 + t * 0.03);
    const chop = Math.sin(x * 0.55 - t * 0.28) * amp;
    const ripple = 0.25 * Math.sin(x * 1.3 + t * 0.5);
    h.push(0.5 + 0.18 * swell + 0.26 * chop + 0.06 * ripple);
  }
  return h;
}

/** two rows of water; kind per cell: 0 empty, 1 water, 2 sharp crest */
export function waterRows(h) {
  const top = [], bot = [];
  for (let x = 0; x < h.length; x++) {
    const v = h[x], l = h[x - 1] ?? v, r = h[x + 1] ?? v;
    const sharp = v - (l + r) / 2;
    if (v > 0.7 && v >= l && v >= r) top.push(sharp > 0.045 ? ['^', 2] : ['~', 1]);
    else if (v > 0.66) top.push([r > l ? '/' : '\\', 1]);
    else if (v > 0.6 && sharp > 0.03) top.push(['.', 1]);
    else top.push([' ', 0]);
    bot.push([v > 0.75 ? ' ' : v > 0.45 ? '~' : v > 0.33 ? '-' : '_', v > 0.75 ? 0 : 1]);
  }
  return [top, bot];
}

const BLOCKS = ' ▁▂▃▄▅▆▇█';
/** filled water: two rows of block elements, height in eighths of a cell (0..16) */
export function blockRows(h) {
  const top = [], bot = [];
  for (const v of h) {
    const n = Math.max(1, Math.min(16, Math.round(v * 16)));
    bot.push([BLOCKS[Math.min(8, n)], 'deep']);
    top.push(n > 8 ? [BLOCKS[n - 8], n >= 14 ? 'crest' : 'water'] : [' ', 'none']);
  }
  return [top, bot];
}

/** block elements render in every current terminal; the old Windows console host (no Windows Terminal) gets line art */
export function blocksSupported(env = process.env, platform = process.platform) {
  if (env.VTO_ASCII === '1') return false;
  if (platform !== 'win32') return true;
  return Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === 'ON' || /xterm|256color/.test(env.TERM || ''));
}

const ANSI = /^\x1b\[[0-9;?]*[A-Za-z]/;
/** visible width of a string without escape sequences (code points) */
export function visibleLength(s) { let n = 0; for (let k = 0; k < s.length;) { const m = ANSI.exec(s.slice(k)); if (m) k += m[0].length; else { k += s.codePointAt(k) > 0xffff ? 2 : 1; n++; } } return n; }
/** cut a string to `max` visible columns, ending with an ellipsis when it was cut (escape sequences are kept, a reset is appended) */
export function truncateVisible(s, max) {
  if (max <= 0) return '';
  if (visibleLength(s) <= max) return s;
  let out = '', n = 0, hasEsc = false;
  for (let k = 0; k < s.length;) {
    const m = ANSI.exec(s.slice(k));
    if (m) { out += m[0]; k += m[0].length; hasEsc = true; continue; }
    if (n >= max - 1) break;
    const cp = String.fromCodePoint(s.codePointAt(k)); out += cp; k += cp.length; n++;
  }
  return out + '…' + (hasEsc ? '\x1b[0m' : '');
}

/** how the swan is laid out on a terminal of this size: { kind: 'frame', width } or { kind: 'line' } */
export function swanLayout(columns, rows) {
  const cols = columns > 0 ? columns : 80;
  if (cols < MIN_COLUMNS || (rows > 0 && rows < HEIGHT + 2)) return { kind: 'line', columns: cols };
  // keep at least ~28 columns for the label; shrink the water first
  return { kind: 'frame', width: Math.max(MIN_WIDTH, Math.min(WIDTH, cols - 1 - 2 - 28)), columns: cols };
}

export function swanFrame(i, label = '', { color = false, blocks = false, width = WIDTH, columns = 0 } = {}) {
  const WIDTH_ = Math.max(MIN_WIDTH, Math.min(WIDTH, width));
  const paint = {
    swan: (t) => (color ? `\x1b[38;5;69m${t}\x1b[39m` : t),
    water: (t) => (color ? `\x1b[38;5;33m${t}\x1b[39m` : t),
    deep: (t) => (color ? `\x1b[38;5;26m${t}\x1b[39m` : t),
    crest: (t) => (color ? `\x1b[38;5;117m${t}\x1b[39m` : t),
  };
  const t = i * 1.0;
  const h = surface(t, WIDTH_);
  const [top, bot] = blocks ? blockRows(h) : waterRows(h).map((row, r) => row.map(([c, k]) => [c, k === 2 ? 'crest' : k ? 'water' : 'none']));
  // glides from right to left and comes round again
  const span = WIDTH_ - SW;
  const x = span - (Math.floor(i / 3) % (span + 1));
  // bobs with the water under its body: up on a crest, down in a trough
  const under = h.slice(x + 3, x + 14);
  const up = under.reduce((a, b) => a + b, 0) / under.length > 0.52;
  const y0 = up ? 0 : 1;
  const grid = Array.from({ length: HEIGHT }, () => Array.from({ length: WIDTH_ }, () => [' ', 'none']));
  for (let c = 0; c < WIDTH_; c++) {
    grid[HEIGHT - 2][c] = top[c];
    grid[HEIGHT - 1][c] = bot[c];
  }
  SWAN.forEach((row, r) => { for (let c = 0; c < row.length; c++) if (row[c] !== ' ') grid[y0 + r][x + c] = [row[c], 'swan']; });
  const lines = grid.map((cells) => {
    let out = '', run = '', kind = null;
    const flush = () => { if (run) out += kind === 'none' ? run : paint[kind](run); run = ''; };
    for (const [ch, k] of cells) { if (k !== kind) { flush(); kind = k; } run += ch; }
    flush();
    return out;
  });
  lines[HEIGHT - 1] += '  ' + (columns > 0 ? truncateVisible(label, Math.max(0, columns - 1 - WIDTH_ - 2)) : label);
  return lines;
}

export function animationEnabled(stream = process.stderr, env = process.env) {
  if (env.VTO_NO_ANIMATION === '1' || env.CI || env.GITHUB_ACTIONS || env.TF_BUILD) return false;
  return Boolean(stream && stream.isTTY) && env.TERM !== 'dumb';
}

// startSwan('measuring') → { update(label), log(line), stop() }; a no-op when the animation is off.
// Fits the terminal: the water shrinks and the label is cut with an ellipsis on narrow terminals, and below
// ~50 columns (or a terminal shorter than the frame) a single status line replaces the swan.
export function startSwan(label = '', { stream = process.stderr, env = process.env, delayMs = 400, intervalMs = 120 } = {}) {
  if (!animationEnabled(stream, env)) return { update() {}, stop() {}, log(line) { stream.write(line + '\n'); } };
  const color = colorEnabled(stream, env);
  const blocks = blocksSupported(env);
  const t0 = Date.now();
  let text = label, i = 0, drawn = null, timer = null, stopped = false; // drawn: null | 'frame' | 'line'
  const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
  const draw = () => {
    const lay = swanLayout(stream.columns, stream.rows);
    const sec = secs();
    const room = lay.kind === 'line' ? lay.columns - 1 : lay.columns - 1 - lay.width - 2;
    // cut the text, never the elapsed time
    const shown = truncateVisible(text, Math.max(0, room - sec.length - 1));
    const lab = `${shown} ${color ? `\x1b[2m${sec}\x1b[22m` : sec}`;
    if (drawn && drawn !== lay.kind) clear();
    if (lay.kind === 'line') {
      stream.write((drawn ? '' : '\x1b[?25l') + '\r\x1b[2K' + truncateVisible(lab, lay.columns - 1));
    } else {
      const lines = swanFrame(i, lab, { color, blocks, width: lay.width, columns: lay.columns });
      stream.write((drawn ? `\x1b[${HEIGHT}F` : '\x1b[?25l') + lines.map((l) => `\x1b[2K${l}`).join('\n') + '\n');
    }
    i++;
    drawn = lay.kind;
  };
  const clear = () => {
    if (drawn === 'frame') stream.write(`\x1b[${HEIGHT}F\x1b[J`);
    else if (drawn === 'line') stream.write('\r\x1b[2K');
    drawn = null;
  };
  const restore = () => { if (!stopped) { clear(); stream.write('\x1b[?25h'); } };
  const onExit = () => restore();
  const sigs = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };
  const handlers = Object.entries(sigs).map(([sig, num]) => [sig, () => { restore(); process.exit(128 + num); }]);
  process.once('exit', onExit);
  for (const [sig, h] of handlers) process.once(sig, h);
  const start = setTimeout(() => { draw(); timer = setInterval(draw, intervalMs); timer.unref?.(); }, delayMs);
  start.unref?.();
  return {
    update(l) { text = l; },
    // print a line above the swan (a failure, a note) without leaving a broken frame behind
    log(line) {
      if (stopped) { stream.write(line + '\n'); return; }
      const was = drawn; clear(); stream.write(line + '\n'); if (was) draw();
    },
    stop() {
      if (stopped) return;
      clearTimeout(start); clearInterval(timer);
      clear();
      stream.write('\x1b[?25h');
      stopped = true;
      process.off('exit', onExit);
      for (const [sig, h] of handlers) process.off(sig, h);
    },
  };
}
