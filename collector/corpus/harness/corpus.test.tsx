// Executes every corpus case scenario and writes a deterministic, serialized result per case.
// This file is a *test file*, so a spec-conforming instrumenter must not instrument it; all
// helpers that scenarios need (rendering, events, ...) are passed in from here so that a broken
// instrumenter cannot break the helpers themselves.
import { test, afterEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import * as React from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { render, fireEvent, act, cleanup, screen, waitFor } from '@testing-library/react';

const OUT = process.env.VTO_CORPUS_OUT!;
const MODE = process.env.VTO_CORPUS_MODE ?? 'base';
const ONLY = (process.env.VTO_CORPUS_ONLY ?? '').split(',').filter(Boolean);
const SKIP = new Set((process.env.VTO_CORPUS_SKIP ?? '').split(',').filter(Boolean));
mkdirSync(OUT, { recursive: true });

const mods = import.meta.glob('../cases/*.{ts,tsx,js,jsx,mts}');

// ---------- deterministic serializer ----------
function normStr(s: string) {
  // strip file locations (line:col differ under instrumentation) and absolute paths
  return s
    .replace(/\(?(?:file:\/\/)?\/[^\s()]*?:\d+:\d+\)?/g, '<loc>')
    .replace(/https?:\/\/\S+?:\d+:\d+/g, '<loc>');
}
export function ser(v: any, seen = new Map<any, number>(), depth = 0): any {
  if (depth > 40) return { $deep: true };
  const t = typeof v;
  if (v === undefined) return { $u: 1 };
  if (v === null || t === 'boolean') return v;
  if (t === 'string') return normStr(v);
  if (t === 'number') {
    if (Number.isNaN(v)) return { $n: 'NaN' };
    if (!Number.isFinite(v)) return { $n: String(v) };
    if (Object.is(v, -0)) return { $n: '-0' };
    return v;
  }
  if (t === 'bigint') return { $big: String(v) };
  if (t === 'symbol') return { $sym: v.description ?? null };
  if (t === 'function') return { $fn: v.name, len: v.length, cls: /^class[\s{]/.test(Function.prototype.toString.call(v)) };
  if (seen.has(v)) return { $cycle: seen.get(v) };
  seen.set(v, seen.size);
  if (v instanceof Error) return { $err: v.name, msg: normStr(v.message), cause: 'cause' in v ? ser((v as any).cause, seen, depth + 1) : undefined };
  if (v instanceof Date) return { $date: isNaN(+v) ? 'invalid' : v.toISOString() };
  if (v instanceof RegExp) return { $re: String(v) };
  if (v instanceof Map) return { $map: [...v].map(([k, x]) => [ser(k, seen, depth + 1), ser(x, seen, depth + 1)]) };
  if (v instanceof Set) return { $set: [...v].map((x) => ser(x, seen, depth + 1)) };
  if (ArrayBuffer.isView(v)) return { $ta: v.constructor.name, d: Array.from(v as any, (x: any) => ser(x, seen, depth + 1)) };
  if (typeof Node !== 'undefined' && v instanceof Node) return { $node: (v as any).outerHTML ?? v.textContent };
  if (Array.isArray(v)) {
    const out: any[] = [];
    for (let i = 0; i < v.length; i++) out.push(i in v ? ser(v[i], seen, depth + 1) : { $hole: 1 });
    const extra = Object.keys(v).filter((k) => !/^\d+$/.test(k));
    return extra.length ? { $arr: out, props: Object.fromEntries(extra.map((k) => [k, ser(v[k], seen, depth + 1)])) } : out;
  }
  if (typeof v.then === 'function') return { $thenable: true };
  if (React.isValidElement(v)) return { $el: renderToStaticMarkup(v as any) };
  const proto = Object.getPrototypeOf(v);
  const o: any = {};
  if (proto !== Object.prototype && proto !== null) o.$cls = proto?.constructor?.name ?? '?';
  if (proto === null) o.$nullproto = true;
  for (const k of Reflect.ownKeys(v)) {
    const d = Object.getOwnPropertyDescriptor(v, k)!;
    if (!d.enumerable) continue;
    const key = typeof k === 'symbol' ? `@@${k.description}` : k;
    try { o[key] = ser(v[k as any], seen, depth + 1); } catch (e) { o[key] = { $threw: ser(e, seen, depth + 1) }; }
  }
  return o;
}

// ---------- coverage registry snapshot ----------
function regSnapshot(file: string) {
  const reg: any = (globalThis as any).__vto_reg;
  if (!reg) return null;
  const keys = reg instanceof Map ? [...reg.keys()] : Object.keys(reg);
  const base = path.basename(file);
  const norm = (k: string) => k.replace(/^file:\/\//, '').replace(/[?#].*$/, '').replace(/\\/g, '/');
  const key = keys.find((k) => norm(k) === file) ?? keys.find((k) => norm(k).endsWith('/cases/' + base));
  if (key === undefined) return { found: false, keys: keys.length };
  let entry: any = reg instanceof Map ? reg.get(key) : reg[key];
  let blocks: any = null;
  if (entry && !ArrayBuffer.isView(entry) && !Array.isArray(entry)) {
    blocks = entry.blocks ?? null;
    entry = entry.hits ?? entry.arr ?? entry.k ?? entry.counters;
  }
  const g: any = globalThis;
  blocks ??= g.__vto_blk?.[key] ?? g.__vto_blocks?.[key] ?? g.__vto_meta?.[key]?.blocks ?? g.__vto_meta?.[key] ?? g.__vto_files?.[key]?.blocks ?? null;
  if (typeof blocks === 'string') { try { blocks = JSON.parse(blocks); } catch { blocks = null; } }
  const hits: number[] = [];
  const len = entry?.length ?? 0;
  for (let i = 0; i < len; i++) if (entry[i]) hits.push(i);
  return { found: true, key, len, hits, blocks };
}

const helpers = {
  React, renderToStaticMarkup, renderToString, render, fireEvent, act, cleanup, screen, waitFor,
  tick: (ms = 0) => new Promise((r) => setTimeout(r, ms)),
};

afterEach(() => cleanup());

for (const [rel, load] of Object.entries(mods)) {
  const name = path.basename(rel);
  if (ONLY.length && !ONLY.some((o) => name.includes(o))) continue;
  if (SKIP.has(name)) continue;
  const abs = path.resolve(path.dirname(new URL(import.meta.url).pathname), rel);
  test(name, async () => {
    writeFileSync(path.join(OUT, name + '.start'), '');
    const logs: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const k of Object.keys(orig) as (keyof typeof orig)[]) {
      (console as any)[k] = (...a: any[]) => logs.push(k + ': ' + normStr(format(...a)));
    }
    let rec: any = { case: name, mode: MODE };
    const t0 = performance.now();
    try {
      const mod: any = await load();
      rec.exports = Object.keys(mod).sort();
      if (typeof mod.scenario !== 'function') throw new Error('case has no scenario export');
      const r = await mod.scenario(helpers);
      rec.result = ser(r);
    } catch (e) {
      rec.error = ser(e);
    } finally {
      Object.assign(console, orig);
    }
    rec.logs = logs;
    rec.ms = performance.now() - t0;
    rec.cov = regSnapshot(abs);
    writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(rec));
  });
}
