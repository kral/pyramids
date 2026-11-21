// vto daemon: one per project root. Hosts a long-lived Engine (warm lanes, fix loop, live
// coverage) behind the IPC protocol (PROTOCOL.md). Lazily started by clients, idle shutdown.
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from './engine.mjs';
import { createServer, ensurePrivateDir, endpointDir, logField } from './ipc.mjs';
import { canonicalRoot } from './paths.mjs';
import { StateDir, appendPrivate, readPrivate } from './safefs.mjs';
import { dispatch } from './api.mjs';

export async function serve(root, { idleMinutes } = {}) {
  root = canonicalRoot(root); // D2.1
  // N5/F11: .vto/ is a real 0700 directory; the log is opened without following symlinks, 0600.
  // One log entry is one line: control characters in any field are escaped (N8 log forging).
  const sd = new StateDir(root, '.vto');
  const log = (m) => { try { appendPrivate(sd.file('daemon.log'), `${new Date().toISOString()} [${process.pid}] ${logField(m, 4000)}\n`); } catch {} };
  const eng = await new Engine(root, { mode: 'daemon', log }).init();
  const idleMs = (idleMinutes ?? eng.config.idleMinutes ?? 30) * 60e3;
  let lastActivity = Date.now();
  let srv;
  const subs = new Set();

  eng.on('event', (ev, topic) => {
    for (const c of subs) {
      if (c.topics && !c.topics.has(topic) && !c.topics.has(ev.ev)) continue;
      c.send(ev);
    }
  });

  const shutdown = async (why) => {
    log(`shutting down: ${why}`);
    clearInterval(idleTimer);
    try { srv?.close(); } catch {}
    await eng.close().catch(() => {});
    process.exit(0);
  };

  const onRequest = async (c, method, params) => {
    lastActivity = Date.now();
    if (method === 'subscribe') {
      const topics = Array.isArray(params.topics) && params.topics.length ? new Set(params.topics.map(String).slice(0, 10)) : null;
      const wantsCov = !topics || topics.has('coverage');
      if (c.cov && !wantsCov) eng.coverageSubs--;
      if (!c.cov && wantsCov) eng.coverageSubs++;
      c.cov = wantsCov; c.topics = topics;
      if (params.coverageCap) eng.config.coverageCap = Math.max(1, Math.min(50, +params.coverageCap || 3));
      if (!subs.has(c)) { subs.add(c); c.once('close', () => { subs.delete(c); if (c.cov) eng.coverageSubs--; c.cov = false; }); }
      // replay the active run so late subscribers (TUI started mid-run) get the full picture
      if (params.replay !== false && eng.active?.runId) replayRun(eng, eng.active.runId, c);
      return { subscribed: topics ? [...topics] : 'all', activeRun: eng.active?.runId ?? null };
    }
    if (method === 'unsubscribe') { subs.delete(c); if (c.cov) { eng.coverageSubs--; c.cov = false; } return { ok: true }; }
    if (method === 'stop') { setTimeout(() => shutdown(`stop requested by ${c.client}`), 50); return { stopping: true }; }
    log(`${c.client}: ${method}`);
    return dispatch(eng, method, { ...params, __via: c.client === 'vto-mcp' ? 'mcp' : 'ipc', __client: c.client });
  };

  srv = await createServer({ root, onRequest, log });
  log(`listening (${process.platform}) root=${root}`);
  const idleTimer = setInterval(() => {
    if (eng.active) { lastActivity = Date.now(); return; }
    if (Date.now() - lastActivity > idleMs && !srv.conns.size) shutdown('idle');
    // idle lanes: close the fix lane after 5 min unused to free memory
    for (const n of ['fix', 'clean']) { const l = eng.lanes.get(n); if (l?.alive && !l.busy && Date.now() - l.lastUsed > 5 * 60e3) l.close().catch(() => {}); }
    eng.enforceLaneBudget(eng.active?.laneNames || []).catch(() => {});
  }, 15e3);
  idleTimer.unref?.();
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => shutdown(s));
  process.on('uncaughtException', (e) => log(`uncaught: ${e.stack || e}`));
  process.on('unhandledRejection', (e) => log(`unhandled: ${e?.stack || e}`));
  return { eng, srv };
}

function replayRun(eng, runId, c) {
  try {
    const f = path.join(eng.dir, 'runs', `${runId}.jsonl`);
    for (const l of (readPrivate(f)?.toString('utf8') ?? '').split('\n')) {
      if (!l) continue;
      const ev = JSON.parse(l);
      const topic = ev.ev === 'coverage' ? 'coverage' : ev.ev === 'test' || ev.ev === 'file-start' ? 'test' : 'run';
      if (c.topics && !c.topics.has(topic) && !c.topics.has(ev.ev)) continue;
      c.send({ ...ev, replay: true });
    }
  } catch {}
}

export { ensurePrivateDir, endpointDir };
