// Parent side of a lane process (src/lane.mjs): fork, request/response, crash handling, tree kill.
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killTree } from './platform.mjs';
import { StateDir, openPrivate } from './safefs.mjs';

const LANE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lane.mjs');

export class Lane {
  constructor(name, { root, rawDir, opts = {}, log = () => {}, env = {}, stateDir }) {
    Object.assign(this, { name, root, rawDir, opts, log, env });
    this.sd = stateDir || new StateDir(root, '.vto');
    this.rssMB = 0;
    this.proc = null; this.ready = null; this.info = null; this.current = null; this.listReq = new Map(); this.reqSeq = 0;
    this.lastUsed = Date.now();
  }
  /** a run or a list request is in flight */
  get busy() { return !!this.current || this.listReq.size > 0 || !!this.pendingRuns; }
  get alive() { return !!this.proc && this.proc.exitCode === null && !this.proc.killed; }
  start() {
    if (this.ready) return this.ready;
    // N5: no symlink below .vto/ is followed (raw dir, log file); files 0600
    this.sd.verify(...path.relative(this.sd.root, this.rawDir).split(path.sep));
    const out = openPrivate(this.sd.file(`lane-${this.name}.log`), 'a');
    // detached: own process group on POSIX → the whole worker tree can be killed at once
    this.proc = fork(LANE, [], {
      cwd: this.root, stdio: ['ignore', out, out, 'ipc'], detached: process.platform !== 'win32', windowsHide: true,
      env: { ...process.env, ...this.env, VTO_RAW_DIR: this.rawDir, VTO_ROOT: this.root, VTO_LANE: this.name, FORCE_COLOR: '0',
        VTO_LANE_OPTS: JSON.stringify({ ...this.opts, root: this.root }) },
    });
    fs.closeSync(out);
    this.ready = new Promise((resolve, reject) => {
      this.proc.on('message', (m) => this.onMessage(m, resolve, reject));
      this.proc.on('exit', (code, sig) => {
        const err = new Error(`lane ${this.name} exited (${code ?? sig}); see .vto/lane-${this.name}.log`);
        reject(err);
        if (this.current) { this.current.reject(err); this.current = null; }
        for (const r of this.listReq.values()) r.reject(err);
        this.listReq.clear();
        this.proc = null; this.ready = null; this.rssMB = 0;
      });
    });
    return this.ready;
  }
  onMessage(m, resolve, reject) {
    if (m.type === 'ready') { this.info = m.info; resolve(m.info); return; }
    if (m.type === 'fatal') { reject(new Error(m.message)); return; }
    if (m.type === 'error') { this.log(`[lane ${this.name}] ${m.message}`); return; }
    if (m.type === 'list') { const r = this.listReq.get(m.reqId); this.listReq.delete(m.reqId); if (r) m.error ? r.reject(new Error(m.error)) : r.resolve(m.files); return; }
    const c = this.current;
    if (!c || (m.runId ?? m.ev?.runId) !== c.runId) return;
    if (m.type === 'done') { this.current = null; if (m.rssMB) this.rssMB = m.rssMB; c.resolve(m); return; }
    try { c.onMsg(m); } catch (e) { this.log(`[lane ${this.name}] handler: ${e.stack}`); }
  }
  /** runs are serialised per lane (the fix loop and fix-lane re-runs share the fix lane) */
  run(msg, onMsg) {
    const go = async () => {
      await this.start();
      this.lastUsed = Date.now();
      return new Promise((resolve, reject) => {
        this.current = { runId: msg.runId, resolve, reject, onMsg };
        this.proc.send({ type: 'run', ...msg });
      }).finally(() => { this.lastUsed = Date.now(); });
    };
    this.pendingRuns = (this.pendingRuns || 0) + 1;
    const p = (this.chain || Promise.resolve()).then(go, go).finally(() => { this.pendingRuns--; });
    this.chain = p.catch(() => {});
    return p;
  }
  async list() {
    await this.start();
    const reqId = ++this.reqSeq;
    return new Promise((resolve, reject) => { this.listReq.set(reqId, { resolve, reject }); this.proc.send({ type: 'list', reqId }); });
  }
  cancel() { if (this.alive) this.proc.send({ type: 'cancel' }); }
  async close() {
    if (!this.alive) return;
    const p = this.proc;
    try { p.send({ type: 'close' }); } catch {}
    const done = new Promise((r) => p.once('exit', r));
    const t = setTimeout(() => this.kill(), 5000);
    await done; clearTimeout(t);
  }
  kill() { if (this.proc?.pid) killTree(this.proc.pid); }
}
