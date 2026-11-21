// Terminal presentation for the closing summary of check / verify / compare.
// Colour only on an interactive terminal; NO_COLOR disables, FORCE_COLOR (not "0") forces.
// Plain output (CI, pipes, files) keeps the same lines without escape codes, so logs stay greppable.

export function colorEnabled(stream = process.stdout, env = process.env) {
  if ('NO_COLOR' in env && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '') return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  return Boolean(stream && stream.isTTY) && env.TERM !== 'dumb';
}

export function painter(on) {
  const w = (open, close) => (s) => (on ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
  return { on, bold: w(1, 22), dim: w(2, 22), red: w(31, 39), green: w(32, 39), yellow: w(33, 39), cyan: w(36, 39) };
}

// visible width: escape codes do not count
const ANSI = /\x1b\[[0-9;]*m/g;
export const width = (s) => [...String(s).replace(ANSI, '')].length;
const pad = (s, n, right) => { const g = ' '.repeat(Math.max(0, n - width(s))); return right ? g + s : s + g; };

// rows: arrays of cells; align: 'l' | 'r' per column
export function table(headers, rows, align = [], p = painter(false)) {
  const all = [headers, ...rows];
  const ws = headers.map((_, i) => Math.max(...all.map((r) => width(r[i] ?? ''))));
  const line = (r) => r.map((cell, i) => pad(String(cell ?? ''), ws[i], align[i] === 'r')).join('  ').trimEnd();
  return [p.dim(line(headers)), ...rows.map(line)];
}

const VERDICT = {
  ok: { sym: '✓', ascii: 'OK', color: 'green' },
  warn: { sym: '!', ascii: 'ACTION', color: 'yellow' },
  fail: { sym: '✗', ascii: 'FAIL', color: 'red' },
};

// One closing block: title, verdict line, key/value facts, optional table, next steps.
export function summary({ title, verdict, label, headline, facts = [], tableLines = [], next = [] }, { out = (s) => console.log(s), stream = process.stdout, env = process.env } = {}) {
  const p = painter(colorEnabled(stream, env));
  const v = VERDICT[verdict] || VERDICT.fail;
  const unicode = p.on || process.platform !== 'win32';
  const rule = p.dim((unicode ? '─' : '-').repeat(60));
  const lines = [rule, ` ${p.bold('vitest-guard ' + title)}`];
  const tag = p[v.color](p.bold(`${unicode ? v.sym + ' ' : ''}${label || v.ascii}`));
  lines.push(` ${tag}  ${headline}`);
  const kw = Math.max(0, ...facts.filter(([, val]) => val !== undefined && val !== null && val !== '').map(([k]) => width(k)));
  for (const [k, val, tone] of facts) {
    if (val === undefined || val === null || val === '') continue;
    const s = String(val);
    lines.push(`   ${p.dim(pad(k, kw))}  ${tone ? p[tone](s) : s}`);
  }
  if (tableLines.length) { lines.push(''); for (const l of tableLines) lines.push('   ' + l); }
  if (next.length) { lines.push(''); for (const n of next) lines.push(` ${p.cyan(unicode ? '→' : '>')} ${n}`); }
  lines.push(rule);
  out(lines.join('\n'));
  return lines;
}

// exit code (D3) -> verdict
export const verdictOf = (code) => (code === 0 ? 'ok' : code === 4 ? 'warn' : 'fail');
