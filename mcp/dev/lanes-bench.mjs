#!/usr/bin/env node
// One-lane vs two-lane (dom/node groups) on a project copy with an existing map. Linux (tree CPU via /proc).
//   node dev/lanes-bench.mjs --root DIR --edit 'file|from|to' --configs '[{"pool":"vm"},{"pool":"auto"}]' [--full] --out file
import fs from 'node:fs';
import path from 'node:path';
import { Backend, connectDaemon } from '../src/client.mjs';
import { treeCpuMs } from './proc-cpu.mjs';
const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const root = path.resolve(opt('--root'));
const [ef, from, to] = opt('--edit').split('|');
const configs = JSON.parse(opt('--configs'));
const full = a.includes('--full');
const out = [];
const edit = (x, y) => { const p = path.join(root, ef); const s = fs.readFileSync(p, 'utf8'); if (!s.includes(x)) throw new Error('edit target not found'); fs.writeFileSync(p, s.replace(x, y)); };
for (const cfg of configs) {
  const c0 = await connectDaemon(root, { autostart: false }).catch(() => null);
  if (c0) { await c0.call('stop').catch(() => {}); await new Promise((r) => setTimeout(r, 1500)); }
  fs.writeFileSync(path.join(root, '.vto', 'config.json'), JSON.stringify(cfg));
  const b = await Backend.open(root, { daemon: true, client: 'lanes-bench' });
  const pid = (await b.call('status')).pid;
  const run = async (params) => { const c = treeCpuMs(pid); const t = Date.now(); const s = await b.call('start_run', params); const r = await b.call('wait_run', { runId: s.runId }); return { wallMs: Date.now() - t, treeCpuMs: Math.round(treeCpuMs(pid) - c), ran: r.ran, failed: r.failed, pool: r.pool, laneMs: r.laneMs, runMs: r.ms }; };
  const res = { config: cfg };
  res.warmup = await run({ kind: 'affected' }); // starts the lanes (not counted)
  if (full) res.full = await run({ kind: 'full' });
  edit(from, to); res.edit = await run({ kind: 'affected' });
  edit(to, from); res.revert = await run({ kind: 'affected' });
  res.edit2 = null;
  edit(from, to); res.edit2 = await run({ kind: 'affected' }); edit(to, from); await run({ kind: 'affected' });
  out.push(res);
  console.error(JSON.stringify(res));
  await b.call('stop').catch(() => {}); await b.close();
  await new Promise((r) => setTimeout(r, 1500));
}
fs.writeFileSync(opt('--out', '/tmp/lanes-bench.json'), JSON.stringify(out, null, 1));
