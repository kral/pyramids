// A small ASCII swan that glides on rippling water while a long operation runs.
// Shown only on an interactive terminal (stderr), after a short delay so quick operations never flash it.
// Off in CI, when stderr is not a TTY, with TERM=dumb, or with VTO_NO_ANIMATION=1. Colour follows NO_COLOR/FORCE_COLOR.
import { colorEnabled } from './ui.mjs';

// the vto logo as ASCII: arched head, S-shaped neck, body rising to the right; it rides on generated waves
const SWAN = [
  '   .-.            ',
  '  /   \\           ',
  '      /           ',
  "     /         _.-'",
  "    (     _.-'    ",
  "     `--'         ",
];
const SW = Math.max(...SWAN.map((r) => r.length));
const WIDTH = 44;
const HEIGHT = SWAN.length + 2; // one row of bobbing room + two rows of water (the swan's lowest line can sit on the crests)

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

export function swanFrame(i, label = '', { color = false } = {}) {
  const paint = { swan: (t) => (color ? `\x1b[38;5;69m${t}\x1b[39m` : t), water: (t) => (color ? `\x1b[2m\x1b[38;5;69m${t}\x1b[39m\x1b[22m` : t), crest: (t) => (color ? `\x1b[38;5;153m${t}\x1b[39m` : t) };
  const t = i * 1.0;
  const h = surface(t);
  const [top, bot] = waterRows(h);
  // glides from right to left and comes round again
  const span = WIDTH - SW;
  const x = span - (Math.floor(i / 3) % (span + 1));
  // bobs with the water under its body: up on a crest, down in a trough
  const under = h.slice(x + 3, x + 14);
  const up = under.reduce((a, b) => a + b, 0) / under.length > 0.52;
  const y0 = up ? 0 : 1;
  const grid = Array.from({ length: HEIGHT }, () => Array.from({ length: WIDTH }, () => [' ', 'none']));
  for (let c = 0; c < WIDTH; c++) {
    grid[HEIGHT - 2][c] = [top[c][0], top[c][1] === 2 ? 'crest' : top[c][1] ? 'water' : 'none'];
    grid[HEIGHT - 1][c] = [bot[c][0], bot[c][1] ? 'water' : 'none'];
  }
  SWAN.forEach((row, r) => { for (let c = 0; c < row.length; c++) if (row[c] !== ' ') grid[y0 + r][x + c] = [row[c], 'swan']; });
  const lines = grid.map((cells) => {
    let out = '', run = '', kind = null;
    const flush = () => { if (run) out += kind === 'none' ? run : paint[kind](run); run = ''; };
    for (const [ch, k] of cells) { if (k !== kind) { flush(); kind = k; } run += ch; }
    flush();
    return out;
  });
  lines[HEIGHT - 1] += '  ' + label;
  return lines;
}

export function animationEnabled(stream = process.stderr, env = process.env) {
  if (env.VTO_NO_ANIMATION === '1' || env.CI || env.GITHUB_ACTIONS || env.TF_BUILD) return false;
  return Boolean(stream && stream.isTTY) && env.TERM !== 'dumb';
}

// startSwan('measuring') → { update(label), stop() }; a no-op when the animation is off
export function startSwan(label = '', { stream = process.stderr, env = process.env, delayMs = 400, intervalMs = 120 } = {}) {
  if (!animationEnabled(stream, env)) return { update() {}, stop() {}, log(line) { stream.write(line + '\n'); } };
  const color = colorEnabled(stream, env);
  const t0 = Date.now();
  let text = label, i = 0, drawn = false, timer = null, stopped = false;
  const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
  const draw = () => {
    const lines = swanFrame(i++, `${text} ${color ? `\x1b[2m${secs()}\x1b[22m` : secs()}`, { color });
    stream.write((drawn ? `\x1b[${HEIGHT}F` : '\x1b[?25l') + lines.map((l) => `\x1b[2K${l}`).join('\n') + '\n');
    drawn = true;
  };
  const clear = () => { if (drawn) stream.write(`\x1b[${HEIGHT}F\x1b[J`); drawn = false; };
  const restore = () => { if (!stopped) { clear(); stream.write('\x1b[?25h'); } };
  const onExit = () => restore();
  const onSig = () => { restore(); process.exit(130); };
  process.once('exit', onExit);
  process.once('SIGINT', onSig);
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
      process.off('exit', onExit); process.off('SIGINT', onSig);
    },
  };
}
