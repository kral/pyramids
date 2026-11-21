// Client side: find (or lazily start) the daemon of a project root; fall back to an in-process
// Engine when the daemon is disabled or cannot start (stateless mode, same API).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { readEndpoint, connectTo, acquireStartLock, endpointDir } from './ipc.mjs';
import { spawnDetached, isAlive } from './platform.mjs';
import { canonicalRoot } from './paths.mjs';
import { StateDir } from './safefs.mjs';
import { Engine } from './engine.mjs';
import { dispatch } from './api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_BIN = path.resolve(here, '../bin/vto-daemon.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Nearest directory (upwards) with a vitest/vite config or package.json. */
export function findRoot(start = process.cwd()) {
  let d = path.resolve(start);
  let pkg = null;
  for (;;) {
    for (const n of fs.existsSync(d) ? fs.readdirSync(d) : []) if (/^(vitest|vite)\.config\.[cm]?[jt]s$/.test(n)) return d;
    if (!pkg && fs.existsSync(path.join(d, 'package.json'))) pkg = d;
    const up = path.dirname(d);
    if (up === d) return pkg || path.resolve(start);
    d = up;
  }
}

export async function connectDaemon(root, { autostart = true, client = 'vto-cli', waitMs = 20000 } = {}) {
  root = canonicalRoot(root);
  const tryConnect = async () => {
    const ep = readEndpoint(root);
    if (!ep || !isAlive(ep.pid)) return null;
    try { return await connectTo(ep, { client }); } catch { return null; }
  };
  let c = await tryConnect();
  if (c || !autostart) return c;
  const release = acquireStartLock(root);
  try {
    if (release) {
      // N5/F11: .vto/ is created 0700 here too (first creation), never through a symlink; log 0600
      const sd = new StateDir(root, '.vto');
      spawnDetached(DAEMON_BIN, ['serve', root], { cwd: root, logFile: sd.file('daemon.out.log') });
    }
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      await sleep(150);
      c = await tryConnect();
      if (c) return c;
    }
    throw new Error(`vto daemon did not start within ${waitMs / 1000}s (see ${path.join(root, '.vto', 'daemon.log')})`);
  } finally { release?.(); }
}

/** Same surface for daemon and in-process engine: call(method, params) + 'event' emitter. */
export class Backend extends EventEmitter {
  static async open(root, { daemon = true, client = 'vto-cli' } = {}) {
    const b = new Backend();
    root = canonicalRoot(root); // D2.1: one daemon per project, whatever spelling the client used
    b.root = root;
    b.clientName = client;
    if (daemon && process.env.VTO_NO_DAEMON !== '1') {
      try {
        b.client = await connectDaemon(root, { client });
        b.client.on('event', (ev) => b.emit('event', ev));
        b.client.on('close', () => b.emit('close'));
        b.kind = 'daemon';
        return b;
      } catch (e) { b.daemonError = e.message; }
    } else if (process.env.VTO_NO_DAEMON !== '1' || !daemon) {
      // stateless use while a daemon owns .vto/: talk to it instead of writing the same state
      const c = await connectDaemon(root, { autostart: false, client }).catch(() => null);
      if (c) { b.client = c; c.on('event', (ev) => b.emit('event', ev)); c.on('close', () => b.emit('close')); b.kind = 'daemon'; b.note = 'a daemon is running for this root: used it instead of an in-process engine'; return b; }
    }
    b.engine = await new Engine(root, { mode: 'stateless' }).init();
    b.engine.on('event', (ev, topic) => b.emit('event', ev, topic));
    b.kind = 'in-process';
    return b;
  }
  call(method, params = {}) {
    if (this.client) return this.client.call(method, params);
    if (method === 'subscribe') { if (!params.topics || params.topics.includes?.('coverage')) this.engine.coverageSubs++; return Promise.resolve({ subscribed: 'all' }); }
    if (method === 'stop') return Promise.resolve({ stopping: false, note: 'no daemon' });
    // same trust labels as the daemon adds per connection (mcpAllowRuns, task note origin)
    return dispatch(this.engine, method, { ...params, __via: this.clientName === 'vto-mcp' ? 'mcp' : 'ipc', __client: this.clientName });
  }
  async close() { if (this.client) this.client.close(); if (this.engine) await this.engine.close(); }
}

export { endpointDir };
