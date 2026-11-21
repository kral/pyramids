// engine.lock: one engine (daemon or stateless CLI/MCP) per .vto/ – two writers would clobber state.json.
// Part of the Engine (src/engine.mjs): methods are installed on Engine.prototype, `this` is the engine.
//
// REVIEW-2-architecture N5 / A-8:
//  - creation is O_EXCL; a STALE lock is never unlinked blindly. Whoever wants to take it over
//    first takes `engine.lock.takeover` (O_EXCL), re-reads the lock, removes it only when it still
//    is the very lock it judged stale (same pid + nonce), and creates its own – so two processes
//    that both saw the stale lock cannot both end up owning .vto/.
//  - liveness = the owner pid is alive AND the owner refreshed the lock recently (heartbeat mtime).
//    A recycled pid (frequent on Windows) therefore stops blocking after STALE_MS instead of forever.
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isAlive } from './platform.mjs';
import { openPrivate } from './safefs.mjs';

export const HEARTBEAT_MS = 5000;
export const STALE_MS = 120000;      // owner alive but silent this long = not our lock holder (pid reuse)
export const TAKEOVER_STALE_MS = 10000;

const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };

function readLock(file) {
  try { const s = fs.lstatSync(file); if (!s.isFile()) return { broken: true }; return { ...JSON.parse(fs.readFileSync(file, 'utf8')), mtimeMs: s.mtimeMs }; }
  catch (e) { return e.code === 'ENOENT' ? null : { broken: true, mtimeMs: (() => { try { return fs.lstatSync(file).mtimeMs; } catch { return 0; } })() }; }
}
/** is the lock described by `o` held by a living engine? */
export function lockAlive(o, now = Date.now(), alive = isAlive) {
  if (!o || o.broken || !o.pid) return o?.broken ? now - (o.mtimeMs || 0) < 2000 : false; // half-written lock: give its writer a moment
  if (!alive(o.pid)) return false;
  return now - (o.mtimeMs || o.at || 0) < STALE_MS;
}
function createLock(file, body) {
  const fd = openPrivate(file, 'wx'); // O_EXCL | O_NOFOLLOW, 0600
  try { fs.writeSync(fd, JSON.stringify(body)); } finally { fs.closeSync(fd); }
}

export class LockMixin {
  acquireLock({ now = Date.now, alive = isAlive } = {}) {
    const body = { pid: process.pid, mode: this.mode, at: now(), nonce: randomBytes(8).toString('hex') };
    const locked = (o) => Object.assign(new Error(`.vto/ is in use by another vto engine (pid ${o?.pid ?? '?'}, ${o?.mode ?? '?'}); use it (daemon) or stop it (vto-daemon stop)`), { code: 'E_LOCKED' });
    for (let attempt = 0; attempt < 5; attempt++) {
      try { createLock(this.lockFile, body); return this.ownLock(body); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
      const seen = readLock(this.lockFile);
      if (seen === null) continue; // released in between
      if (lockAlive(seen, now(), alive)) throw locked(seen);
      // stale: serialise the takeover
      const tk = `${this.lockFile}.takeover`;
      try { createLock(tk, { pid: process.pid, at: now() }); }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // somebody else is taking over right now (or died doing so)
        let age = Infinity; try { age = now() - fs.lstatSync(tk).mtimeMs; } catch { age = 0; }
        if (age > TAKEOVER_STALE_MS) { try { fs.unlinkSync(tk); } catch {} }
        sleepSync(25 + attempt * 25);
        continue;
      }
      try {
        const cur = readLock(this.lockFile);
        // only remove the lock we judged stale; a fresh lock of a competitor stays
        if (cur !== null) {
          if (lockAlive(cur, now(), alive) || cur.pid !== seen.pid || cur.nonce !== seen.nonce || cur.at !== seen.at) { if (lockAlive(cur, now(), alive)) throw locked(cur); continue; }
          fs.unlinkSync(this.lockFile);
        }
        try { createLock(this.lockFile, body); } catch (e) { if (e.code === 'EEXIST') continue; throw e; }
        return this.ownLock(body);
      } finally { try { fs.unlinkSync(tk); } catch {} }
    }
    throw locked(readLock(this.lockFile));
  }
  ownLock(body) {
    this.ownsLock = true; this.lockBody = body;
    this.lockTimer = setInterval(() => { try { const t = new Date(); fs.utimesSync(this.lockFile, t, t); } catch {} }, HEARTBEAT_MS);
    this.lockTimer.unref?.();
  }
  releaseLock() {
    if (this.lockTimer) { clearInterval(this.lockTimer); this.lockTimer = null; }
    if (!this.ownsLock) return;
    try { const o = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')); if (o.pid === process.pid && o.nonce === this.lockBody?.nonce) fs.unlinkSync(this.lockFile); } catch {}
    this.ownsLock = false;
  }
}
