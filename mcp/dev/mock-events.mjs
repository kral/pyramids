#!/usr/bin/env node
// Mock vto daemon for TUI / VS Code client development: serves the real IPC protocol
// (PROTOCOL.md: endpoint discovery, hello+token, subscribe, status, run_status, next_failures)
// and replays a realistic run – or a recorded one – without running any test.
//
//   node dev/mock-events.mjs [--root DIR] [--replay .vto/runs/r12.jsonl] [--speed 1] [--loop] [--tests 400] [--fail 7] [--seed 1]
//
// The TUI connects exactly as to a real daemon (readEndpoint(root) → connectTo). With --root of a
// real project the mock takes that project's daemon slot (stop the real daemon first).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/ipc.mjs';

const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const root = path.resolve(opt('--root', fs.mkdtempSync(path.join(os.tmpdir(), 'vto-mock-'))));
const speed = Number(opt('--speed', 1));
const loop = a.includes('--loop');
const replayFile = opt('--replay', null);
const nTests = Number(opt('--tests', 400)), nFail = Number(opt('--fail', 7));
let seed = Number(opt('--seed', 1));
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const subs = new Set();
let state = { runId: null, status: 'idle', done: 0, failed: 0, total: 0, failures: [] };
const broadcast = (ev) => {
  if (ev.ev === 'failure') state.failures.push(ev);
  for (const c of subs) { const topic = ev.ev === 'coverage' ? 'coverage' : ev.ev === 'test' || ev.ev === 'file-start' ? 'test' : 'run'; if (!c.topics || c.topics.has(topic) || c.topics.has(ev.ev)) c.send(ev); }
};

const srv = await createServer({
  root,
  onRequest: async (c, method, p) => {
    if (method === 'subscribe') { c.topics = Array.isArray(p.topics) && p.topics.length ? new Set(p.topics) : null; subs.add(c); c.once('close', () => subs.delete(c)); return { subscribed: c.topics ? [...c.topics] : 'all', activeRun: state.runId }; }
    if (method === 'status') return { v: 'vto/1', mock: true, root, mode: 'daemon', warm: true, pool: 'vitest-guard:vm', activeRun: state.runId ? { runId: state.runId, done: state.done, total: state.total } : undefined, stale: false };
    if (method === 'run_status') return { v: 'vto/1', runId: state.runId, status: state.status, done: state.done, total: state.total, failed: state.failed };
    if (method === 'next_failures') { const from = +(p.cursor || 0); return { v: 'vto/1', runId: state.runId, failures: state.failures.slice(from, from + (p.limit || 5)).map((f) => ({ id: f.id, error: f.message, group: f.group, at: f.frames.map((x) => `${x.file}:${x.line}`) })), cursor: String(Math.min(state.failures.length, from + (p.limit || 5))), done: state.status === 'done' }; }
    if (method === 'start_run' || method === 'rerun_failed') { setTimeout(() => play().catch(console.error), 10); return { v: 'vto/1', runId: `r${runSeq + 1}`, total: nTests, status: 'queued' }; }
    if (method === 'cancel_run') { cancel = true; return { v: 'vto/1', status: 'cancelling' }; }
    if (method === 'enqueue_task') { const t = { taskId: `t${++taskSeq}`, status: 'open', group: p.group || 'g-mock', count: 1, ids: p.ids || [], failure: state.failures.find((f) => f.group === p.group) || null }; tasks.push(t); broadcast({ ev: 'task', action: 'enqueued', task: { taskId: t.taskId, group: t.group, count: t.count, status: 'open' } }); return { v: 'vto/1', task: t }; }
    if (method === 'list_tasks') return { v: 'vto/1', tasks: tasks.filter((t) => !p.status || p.status === 'all' || t.status === p.status), total: tasks.length };
    if (method === 'claim_task') { const t = tasks.find((x) => (p.taskId ? x.taskId === p.taskId : x.status === 'open')); if (t) { t.status = 'claimed'; t.claimedBy = p.agent || 'agent'; broadcast({ ev: 'task', action: 'claimed', task: { taskId: t.taskId, status: 'claimed', claimedBy: t.claimedBy } }); } return { v: 'vto/1', task: t || null }; }
    if (method === 'complete_task') { const t = tasks.find((x) => x.taskId === p.taskId); if (t) t.status = p.status || 'done'; return { v: 'vto/1', task: t ? { taskId: t.taskId, status: t.status } : null }; }
    if (method === 'coverage') return { v: 'vto/1', file: p.file, covered: '1-20', partial: '21', uncovered: '22-24' };
    if (method === 'stop') { setTimeout(() => process.exit(0), 20); return { stopping: true }; }
    throw Object.assign(new Error(`mock: method ${method} not mocked`), { code: 'E_METHOD' });
  },
});
console.error(`mock vto daemon for ${root}\n  endpoint ${srv.endpoint.address}\n  (clients discover it via the endpoint file of this root)`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms / speed));
let runSeq = 0, cancel = false, taskSeq = 0;
const tasks = [];

async function play() {
  cancel = false;
  if (replayFile) {
    const evs = fs.readFileSync(replayFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const runId = `r${++runSeq}`;
    Object.assign(state, { runId, status: 'running', done: 0, failed: 0, failures: [] });
    for (const ev of evs) { if (cancel) break; ev.runId = runId; if (ev.ev === 'test') { state.done++; await sleep(15); } if (ev.ev === 'run-start') state.total = ev.total; broadcast(ev); }
    state.status = 'done';
    return;
  }
  const runId = `r${++runSeq}`;
  const files = Math.max(1, Math.round(nTests / 10));
  const failAt = new Set(Array.from({ length: nFail }, () => Math.floor(rnd() * nTests)));
  Object.assign(state, { runId, status: 'running', done: 0, failed: 0, total: nTests, failures: [] });
  const t0 = Date.now();
  const domFiles = Math.ceil(files * 0.75);
  broadcast({ ev: 'run-start', runId, kind: 'affected', total: nTests, files, pool: 'vitest-guard:vm', lane: 'main',
    projects: { dom: { files: domFiles, tests: Math.min(nTests, domFiles * 10) }, node: { files: files - domFiles, tests: nTests - Math.min(nTests, domFiles * 10) } } });
  let i = 0, seq = 0;
  for (let f = 0; f < files && !cancel; f++) {
    const file = `src/components/Comp${f}.test.tsx`;
    broadcast({ ev: 'file-start', runId, file, project: f < domFiles ? 'dom' : 'node' });
    for (let k = 0; k < 10 && i < nTests && !cancel; k++, i++) {
      const line = 10 + k * 7;
      const id = `${file}:${line} > Comp${f} > case ${k}`;
      const fail = failAt.has(i);
      const ms = Math.round(5 + rnd() * 40);
      await sleep(ms);
      state.done++;
      broadcast({ ev: 'test', runId, id, state: fail ? 'fail' : 'pass', ms });
      if (fail) {
        state.failed++;
        const group = seq % 3 === 2 ? 'g-000aaa' : `g-${(1000 + seq).toString(16)}`;
        broadcast({ ev: 'failure', runId, seq: ++seq, id, file, line, name: `Comp${f} > case ${k}`,
          message: group === 'g-000aaa' ? "TypeError: Cannot read properties of undefined (reading 'then')" : `AssertionError: expected 'Save' to be 'Uložit'`,
          diff: "- Expected\n+ Received\n\n- Uložit\n+ Save", frames: [{ file: `src/components/Comp${f}.tsx`, line: 17, col: 9, code: "return <button>{t('save')}</button>;" }, { file, line: line + 2, col: 5, code: "expect(screen.getByRole('button')).toHaveTextContent('Uložit')" }],
          group, coveredChanged: [`src/components/Comp${f}.tsx:17`] });
        if (rnd() < 0.4) setTimeout(() => broadcast({ ev: 'fix-rerun', runId, id, state: rnd() < 0.7 ? 'pass' : 'fail' }), 1500 / speed);
      }
      if (state.done % 20 === 0) broadcast({ ev: 'progress', runId, done: state.done, failed: state.failed, etaMs: Math.round(((Date.now() - t0) / state.done) * (nTests - state.done)), total: nTests, files: f, filesTotal: files });
    }
    const src = `src/components/Comp${f}.tsx`;
    broadcast({ ev: 'coverage', runId, file: src, hash: 'mock' + f, lines: { covered: [3, 4, 5, 9, 10], partial: [7], uncovered: [8, 12] }, branches: { 7: [1, 0] }, testsByLine: { 5: [`src/components/Comp${f}.test.tsx:10 > Comp${f} > case 0`] }, complete: false });
  }
  broadcast({ ev: 'progress', runId, done: state.done, failed: state.failed, etaMs: 0, total: nTests, files, filesTotal: files });
  broadcast({ ev: 'run-end', runId, passed: state.done - state.failed, failed: state.failed, skipped: 0, ms: Date.now() - t0, ...(cancel ? { cancelled: true } : {}) });
  state.status = 'done';
}

// first run starts once a subscriber is there (or after 2 s); --loop repeats every 5 s
const startWhenReady = async () => { for (let i = 0; i < 20 && !subs.size; i++) await sleep(100 * speed); await play(); if (loop) { await sleep(5000); startWhenReady(); } };
startWhenReady();
process.on('SIGINT', () => { srv.close(); process.exit(0); });
