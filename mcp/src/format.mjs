// Token-budget formatting (MCP.md "Token budget rules"): compact failures, grouping, pagination.
import fs from 'node:fs';
import path from 'node:path';
import { sha1, slash } from './platform.mjs';

export const tokens = (x) => Math.ceil((typeof x === 'string' ? x : JSON.stringify(x)).length / 4);
const ANSI = /\x1b\[[0-9;]*m/g;

const lineCache = new Map();
function sourceLine(file, line) {
  let lines = lineCache.get(file);
  if (!lines) {
    try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { lines = []; }
    if (lineCache.size > 200) lineCache.clear();
    lineCache.set(file, lines);
  }
  const s = lines[line - 1];
  return s == null ? undefined : s.trim().slice(0, 160);
}
export function clearSourceCache() { lineCache.clear(); }

export function truncLines(s, n, maxChars = 4000) {
  if (!s) return undefined;
  s = String(s).replace(ANSI, '');
  const l = s.split('\n');
  let out = l.length > n ? [...l.slice(0, n), `… ${l.length - n} more lines`].join('\n') : s;
  if (out.length > maxChars) out = out.slice(0, maxChars) + '…';
  return out;
}

/**
 * Vitest TestError → {name, message, diff, frames:[{file,line,col,code}]}; project frames only
 * (inside root, not node_modules), relative paths. `full` keeps more of everything (why_failed).
 */
export function compactError(e, root, { full = false } = {}) {
  if (!e) return { message: 'unknown error' };
  const rootS = slash(root) + '/';
  const frames = [];
  for (const f of e.stacks || []) {
    const file = slash(f.file || '');
    if (!file.startsWith(rootS) || file.includes('/node_modules/')) continue;
    frames.push({ file: file.slice(rootS.length), line: f.line, col: f.column, code: sourceLine(file, f.line) });
    if (frames.length >= (full ? 10 : 3)) break;
  }
  if (!frames.length && e.stack) {
    // unparsed stack (load errors, unhandled): pick project frames by regex
    const re = /\(?((?:[A-Za-z]:)?[^\s()]+):(\d+):(\d+)\)?/g;
    for (const m of String(e.stack).matchAll(re)) {
      let file = slash(m[1].replace(/^file:\/\//, ''));
      if (!file.startsWith(rootS) || file.includes('/node_modules/')) continue;
      frames.push({ file: file.slice(rootS.length), line: +m[2], col: +m[3], code: sourceLine(file, +m[2]) });
      if (frames.length >= (full ? 10 : 3)) break;
    }
  }
  const msg = String(e.message ?? e).replace(ANSI, '');
  return {
    name: e.name && e.name !== 'Error' ? e.name : undefined,
    message: full ? msg.slice(0, 4000) : msg.split('\n').slice(0, 4).join('\n').slice(0, 400),
    diff: truncLines(e.diff, full ? 200 : 40, full ? 16000 : 3000),
    frames,
    ...(full && e.stack ? { stack: truncLines(String(e.stack).split('\n').filter((l) => !/node_modules|node:internal/.test(l)).join('\n'), 15) } : {}),
  };
}

/** group key: normalised first error line + first project frame file */
export function groupOf(err, root) {
  const m = String(err?.message ?? '').split('\n')[0]
    .replace(slash(root) + '/', '').replace(/:\d+:\d+/g, '').replace(/\s+/g, ' ').trim();
  return 'g-' + sha1(m + '|' + (err?.frames?.[0]?.file ?? '')).slice(0, 6);
}

/** MCP compact failure (≤3 frames, short diff). */
export function compactFailure(f, { diffLines = 12 } = {}) {
  const e = f.errors?.[0] || {};
  const o = { id: f.id, error: (e.name ? e.name + ': ' : '') + String(e.message ?? '').split('\n')[0].slice(0, 300) };
  if (e.diff) o.diff = truncLines(e.diff, diffLines, 1200);
  if (e.frames?.length) o.at = e.frames.slice(0, 3).map((x) => `${x.file}:${x.line}`);
  if (e.frames?.[0]?.code) o.src = e.frames[0].code;
  if (f.errors?.length > 1) o.moreErrors = f.errors.length - 1;
  if (f.coveredChanged?.length) o.changed = f.coveredChanged.slice(0, 5);
  if (f.fixed) o.fixedDuringRun = true;
  return o;
}

/** Group identical failures: one entry per group with count + up to 3 sample ids. */
export function groupFailures(fails, limit = 5) {
  const groups = new Map();
  for (const f of fails) {
    const g = groups.get(f.group);
    if (g) { g.count++; if (g.sample.length < 3) g.sample.push(f.id); } else groups.set(f.group, { first: f, count: 1, sample: [] });
  }
  const out = [];
  for (const [gid, g] of groups) {
    const c = compactFailure(g.first);
    c.group = gid;
    if (g.count > 1) { c.sameErrorIn = g.count; c.alsoIn = g.sample; }
    out.push(c);
  }
  return { failures: out.slice(0, limit), groups: out.length, more: Math.max(0, out.length - limit) };
}

/** Pagination helper: cursor is an opaque offset string. */
export function page(items, { limit = 20, cursor } = {}) {
  const off = cursor ? parseInt(cursor, 36) || 0 : 0;
  const slice = items.slice(off, off + limit);
  const next = off + limit < items.length ? (off + limit).toString(36) : undefined;
  return { items: slice, total: items.length, ...(next ? { cursor: next } : {}) };
}

/** Compress a sorted list of line numbers to "3-5,9" ranges. */
export function ranges(lines) {
  const s = [...new Set(lines)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j;
  }
  return out.join(',');
}

export const relTo = (root, f) => slash(path.relative(root, f));
