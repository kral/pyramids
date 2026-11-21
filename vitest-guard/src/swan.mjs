// A small ASCII swan that glides on rippling water while a long operation runs.
// Shown only on an interactive terminal (stderr), after a short delay so quick operations never flash it.
// Off in CI, when stderr is not a TTY, with TERM=dumb, or with VTO_NO_ANIMATION=1. Colour follows NO_COLOR/FORCE_COLOR.
import { colorEnabled } from './ui.mjs';

// the vto logo as ASCII: arched head, S-shaped neck, body rising to the right, an arc of water below
const SWAN = [
  '   .-.           ',
  '  /   \\          ',
  '      /          ',
  "     /         _.-'",
  "    (     _.-'   ",
  "     `--'        ",
];
const ARC = ["   `-.________.-'", "  `-._________.-' "];
const RIPPLE = ' ~   ~~    ~  ~~~   ~    ';
const SW = Math.max(...SWAN.map((r) => r.length), ...ARC.map((r) => r.length));
const WIDTH = 40;
const HEIGHT = SWAN.length + 1;

export function swanFrame(i, label = '', { color = false } = {}) {
  const blue = (t) => (color ? `\x1b[38;5;69m${t}\x1b[39m` : t);
  const dim = (t) => (color ? `\x1b[2m${t}\x1b[22m` : t);
  // glides from right to left and comes round again; small waves trail behind it
  const span = WIDTH - SW;
  const x = span - (Math.floor(i / 3) % (span + 1));
  const pad = (t) => t + ' '.repeat(SW - t.length);
  const lines = SWAN.map((row) => ' '.repeat(x) + blue(pad(row)) + ' '.repeat(span - x));
  const shift = i % RIPPLE.length;
  const trail = (RIPPLE.slice(shift) + RIPPLE).repeat(2).slice(0, span - x);
  lines.push(' '.repeat(x) + blue(pad(ARC[Math.floor(i / 4) % 2])) + dim(blue(trail)) + '  ' + label);
  return lines;
}

export function animationEnabled(stream = process.stderr, env = process.env) {
  if (env.VTO_NO_ANIMATION === '1' || env.CI || env.GITHUB_ACTIONS || env.TF_BUILD) return false;
  return Boolean(stream && stream.isTTY) && env.TERM !== 'dumb';
}

// startSwan('measuring') → { update(label), stop() }; a no-op when the animation is off
export function startSwan(label = '', { stream = process.stderr, env = process.env, delayMs = 400, intervalMs = 120 } = {}) {
  if (!animationEnabled(stream, env)) return { update() {}, stop() {} };
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
