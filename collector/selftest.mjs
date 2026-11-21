// Self-test for plugin.mjs instrumentation: tricky TS/TSX syntax must stay valid and keep semantics.
import { fileURLToPath } from 'node:url';
// node collector/selftest.mjs
import { instrument } from './plugin.mjs';
import { parseSync } from 'oxc-parser';
import assert from 'node:assert/strict';

const cases = {
  'a.tsx': `'use client';
'use strict';
import type { FC } from 'react';
import { useState } from 'react';
export interface P { a?: number; onX?: () => void }
export type T = { b: string } | null;
declare const g: number;
declare function dfn(x: number): void;
export function over(x: string): string;
export function over(x: number): number;
export function over(x: any): any { return x; }
export enum E { A = 1, B = A * 2 }
export const C: FC<P> = ({ a = 1, onX }) => {
  const [n, setN] = useState<number>(a ?? 0);
  return (
    <div onClick={() => setN(n + 1)}>
      {n > 2 && <span>big</span>}
      {n > 5 ? <b>huge</b> : n < 0 ? <i>neg</i> : null}
      {onX || <em>none</em>}
    </div>
  );
};
export default () => ({ ok: true });
export abstract class Base<T> implements Iterable<T> {
  declare foo: string;
  static count = 0;
  private items: T[] = [];
  handle = (e?: T) => e ?? null;
  abstract run(): void;
  constructor(public readonly name: string = 'x') { Base.count++; }
  get size(): number { return this.items.length; }
  set size(v: number) { if (v < 0) throw new Error('neg'); else this.items.length = v; }
  *[Symbol.iterator](): Iterator<T> { for (const i of this.items) yield i; }
  static { Base.count = 0; }
}
function f(x: number) {
  'use strict';
  label: for (let i = 0; i < x; i++) if (i === 3) continue label; else if (i > 5) break;
  switch (x) { case 1: case 2: return 'small'; case 3: { x++; } default: x--; }
  switch (x) { case 9: return 9; }
  while (x-- > 10) x--;
  do x++; while (x < 0);
  try { x = JSON.parse('1') } catch { x = 0 } finally { x ||= 1; }
  let o = { m() { return 1 }, get g() { return 2 }, ['k' + x]: x && 3 };
  if (x) return o.m() as number;
  return (x satisfies number)!;
}
namespace NS { export const v = 1; }
export { f };
`,
  'b.ts': `#!/usr/bin/env node
const a = 1 ?? 2;
export async function* gen(xs: number[] = []) { for await (const x of xs) { if (!x) continue; yield x; } }
export const arrow = async <T,>(x: T): Promise<T> => x;
export const nested = (a: boolean, b: boolean) => a ? b ? 1 : 2 : (a || b) && (a ?? b);
`,
};

for (const [name, code] of Object.entries(cases)) {
  const r = instrument(code, '/abs/' + name, { sourceMap: false });
  assert.ok(r, `${name}: instrumented`);
  const re = parseSync(name, r.code, { sourceType: 'module' });
  if (re.errors.length) { console.error(r.code); console.error(re.errors); process.exit(1); }
  assert.ok(r.code.includes(code.startsWith('#!') ? '#!/usr/bin/env node\n' : "'use client';\n'use strict';"), 'prologue preserved first');
  for (const b of r.blocks) assert.ok(b[0] >= 1 && b[1] >= 0 && (b[2] > b[0] || b[3] >= b[1]) && 'fbs'.includes(b[4]));
  console.log(`${name}: ok, ${r.blocks.length} blocks`);
}

// semantics: run instrumented JS and compare results
const js = `
export function g(x, y = 5) {
  if (x > 10) return 'big';
  let r = x && y;
  r = r || 'z';
  r = r ?? 'n';
  switch (x) { case 1: r = 'one'; break; case 2: case 3: r = 'few'; }
  for (let i = 0; i < x; i++) r += i;
  return x < 0 ? -1 : r;
}`;
const ri = instrument(js, '/abs/sem.js', { sourceMap: false });
const url = 'data:text/javascript,' + encodeURIComponent(ri.code);
const plain = await import('data:text/javascript,' + encodeURIComponent(js));
const inst = await import(url);
for (const args of [[0], [1], [2], [3, 0], [11], [-4], [5, null]]) assert.deepEqual(inst.g(...args), plain.g(...args));
const arr = globalThis.__vto_reg['/abs/sem.js'];
assert.ok(arr && arr.some((v) => v === 1), 'hits recorded');
// unicode: UTF-16 columns
const u = instrument(`// příliš žluťoučký kůň 🐴\nexport const ž = (á) => á ? 'ď' : 'ť';\n`, '/abs/u.ts', { sourceMap: false });
const fb = u.blocks.find((b) => b[4] === 'f');
assert.deepEqual(fb.slice(0, 4), [2, 17, 2, 37]);
console.log('semantics + unicode ok');

// ---- security regressions (SECURITY-REVIEW F5 / F14, sec-scratch/poc5, poc6) ----------------
{
  const { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync } = await import('node:fs');
  const { tmpdir, homedir } = await import('node:os');
  const { spawnSync } = await import('node:child_process');
  const path = (await import('node:path')).default;
  const runner = fileURLToPath(new URL('./run-raw.mjs', import.meta.url));
  const proj = mkdtempSync(path.join(tmpdir(), 'vto-sec-'));
  mkdirSync(path.join(proj, 'src'));
  writeFileSync(path.join(proj, 'src', 'app.ts'), 'export const x = 1;\n');
  writeFileSync(path.join(proj, 'package.json'), '{}');
  const run = (dir) => spawnSync(process.execPath, [runner, dir], { cwd: proj, encoding: 'utf8' });
  // PoC 5: a non-vto directory, the project root, its ancestors, home and / are refused – nothing deleted
  for (const d of ['src', '.', '..', homedir(), '/']) {
    const r = run(d);
    assert.equal(r.status, 2, `run-raw must refuse ${d}: ${r.stderr}`);
  }
  assert.ok(existsSync(path.join(proj, 'src', 'app.ts')), 'PoC5: user file survived');
  // a vto raw dir with a foreign file is refused too
  const raw = path.join(proj, 'raw');
  mkdirSync(raw); writeFileSync(path.join(raw, '.vto-raw'), ''); writeFileSync(path.join(raw, 'notes.txt'), 'keep');
  assert.equal(run(raw).status, 2);
  assert.equal(readFileSync(path.join(raw, 'notes.txt'), 'utf8'), 'keep');
  console.log('F5 raw-dir safety ok');

  // PoC 6: a spoofed pragma does not prevent instrumentation; user `__vto_*` identifiers don't collide
  const { default: plugin } = await import('./plugin.mjs');
  const p = plugin();
  const f = path.join(proj, 'src', 'hidden.ts');
  const hidden = '/*@vto-instrumented*/\nexport function h(x: number) { return x > 1 ? 1 : 0; }\n';
  writeFileSync(f, hidden);
  const out = p.transform.handler.call({ warn() {} }, hidden, f);
  assert.ok(out && /\[\d+\]=1/.test(out.code), 'PoC6: spoofed pragma file is still instrumented');
  assert.equal(p.transform.handler.call({ warn() {} }, out.code, f), undefined, 'own output is not instrumented twice');
  const clash = instrument('let __vto_k = 1; var __vto_i = 2; export const f = (a: any) => (a && __vto_k) + __vto_i;\n', '/abs/clash.ts', { sourceMap: false });
  const cm = await import('data:text/javascript,' + encodeURIComponent(clash.code.replace(/: any/g, '')));
  assert.equal(cm.f(true), 3);
  assert.equal(cm.f(0), 2);
  console.log('F14 pragma spoofing / identifier collision ok');
}
