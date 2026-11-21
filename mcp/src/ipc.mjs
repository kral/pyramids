// Local IPC, protocol "vto-ipc/1" (mcp/PROTOCOL.md): newline-delimited JSON over a Unix domain
// socket (Linux/macOS) or a named pipe (Windows). Never TCP.
//
// Security (SECURITY-REVIEW F2):
//  - POSIX: socket inside a per-user 0700 directory ($XDG_RUNTIME_DIR/vto or ~/.cache/vto/run),
//    owner + mode verified before use; socket chmod 0600. Too long for sun_path (macOS 104 B) →
//    mkdtemp() 0700 dir under os.tmpdir() (never a fixed /tmp name), referenced from the private dir.
//  - Windows: random pipe name per daemon start, published only in a file under %LOCALAPPDATA%
//    (user-profile ACL). Node cannot set a pipe DACL (libuv default DACL: full control for owner,
//    SYSTEM, Administrators; read for Everyone) – write access is what a client needs, and every
//    request additionally requires the token, so other users can neither call nor squat (random name).
//  - 256-bit token in endpoint.json (0600), first message must be `hello {token}`; constant-time compare.
//  - message size cap 1 MiB, lazily started daemon guarded by an O_EXCL lock file.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { sha1, slash, isCaseInsensitiveFs, isAlive } from './platform.mjs';
import { writePrivate } from './safefs.mjs';
import { canonicalRoot } from './paths.mjs';

export const PROTOCOL = 1;
export const MAX_MESSAGE = 1 << 20;

/** Per-user base directory for daemon endpoints (0700, verified). */
export function runtimeBase({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const pp = platform === 'win32' ? path.win32 : path.posix; // the target platform's separators, not the host's
  if (platform === 'win32') return pp.join(env.LOCALAPPDATA || pp.join(home, 'AppData', 'Local'), 'vto', 'run');
  if (env.XDG_RUNTIME_DIR && ownedPrivate(env.XDG_RUNTIME_DIR)) return pp.join(env.XDG_RUNTIME_DIR, 'vto');
  return pp.join(env.XDG_CACHE_HOME || pp.join(home, platform === 'darwin' ? 'Library/Caches' : '.cache'), 'vto', 'run');
}
function ownedPrivate(d) { try { const s = fs.statSync(d); return s.isDirectory() && (process.getuid ? s.uid === process.getuid() : true) && (s.mode & 0o077) === 0; } catch { return false; } }

/** mkdir -p with 0700 for every created level; verify owner/mode of the leaf (POSIX). */
export function ensurePrivateDir(d, { platform = process.platform } = {}) {
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  if (platform === 'win32') return d;
  const s = fs.lstatSync(d);
  if (s.isSymbolicLink() || !s.isDirectory()) throw new Error(`vto: ${d} is not a directory`);
  if (process.getuid && s.uid !== process.getuid()) throw new Error(`vto: ${d} is owned by uid ${s.uid}, not by the current user – refusing to use it`);
  if ((s.mode & 0o077) !== 0) { fs.chmodSync(d, 0o700); if ((fs.statSync(d).mode & 0o077) !== 0) throw new Error(`vto: cannot make ${d} private (mode ${(s.mode & 0o777).toString(8)})`); }
  return d;
}

export function projectKey(root) {
  // D2.1: every spelling of the root (symlink, junction, drive-letter case) names the same daemon
  const r = canonicalRoot(root);
  return sha1(isCaseInsensitiveFs(r) ? r.toLowerCase() : r).slice(0, 16);
}
export function endpointDir(root, opts) { return path.join(runtimeBase(opts), projectKey(root)); }

export function readEndpoint(root) {
  const f = path.join(endpointDir(root), 'endpoint.json');
  try {
    if (process.platform !== 'win32') { const s = fs.statSync(f); if (process.getuid && s.uid !== process.getuid()) return null; if ((s.mode & 0o077) !== 0) return null; }
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch { return null; }
}

/** Choose the address for a new daemon. */
export function newAddress(root, { platform = process.platform } = {}) {
  const dir = ensurePrivateDir(endpointDir(root, { platform }));
  if (platform === 'win32') return { dir, address: `\\\\.\\pipe\\vto-${randomBytes(16).toString('hex')}` };
  let address = path.join(dir, 'd.sock');
  if (Buffer.byteLength(address) > 100) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-'));
    fs.chmodSync(tmp, 0o700);
    address = path.join(tmp, 'd.sock');
    if (Buffer.byteLength(address) > 100) throw new Error('vto: no socket path short enough (sun_path limit)');
  }
  return { dir, address };
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false; // N8: {"token":{"toString":1}} must not throw
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Line framing with a size cap. */
export function lineReader(sock, onLine, onTooBig) {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) onLine(l); }
    if (buf.length > MAX_MESSAGE) { buf = ''; onTooBig?.(); }
  });
}

/** Client-chosen names end up in logs and events: printable ASCII word characters only (N8 log forging). */
export function cleanName(v, max = 60) {
  const s = typeof v === 'string' ? v.replace(/[^A-Za-z0-9._:@/+-]/g, '_').slice(0, max) : '';
  return s || '?';
}
/** One log field on one line: control characters, line separators and bidi marks become \uXXXX. */
export function logField(v, max = 300) {
  return String(v).slice(0, max).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

export const HANDSHAKE_MS = 2000;
export const MAX_UNAUTHED = 16;

// ------------------------------------------------------------------ server
export function createServer({ root, onRequest, onConnection, log = () => {}, handshakeMs = HANDSHAKE_MS, maxUnauthed = MAX_UNAUTHED }) {
  const token = randomBytes(32).toString('hex');
  const { dir, address } = newAddress(root);
  if (process.platform !== 'win32') { try { fs.unlinkSync(address); } catch {} } // our own private dir: stale socket from a crash
  const conns = new Set();
  const server = net.createServer((sock) => {
    const c = Object.assign(new EventEmitter(), { sock, authed: false, topics: null, id: Math.random().toString(36).slice(2, 8) });
    const send = (o) => { if (!sock.destroyed) sock.write(JSON.stringify(o) + '\n'); };
    c.send = send;
    sock.on('error', () => {});
    // N8: unauthenticated connections are capped and must say hello within handshakeMs
    let unauthed = 0;
    for (const x of conns) if (!x.authed) unauthed++;
    if (unauthed >= maxUnauthed) { send({ error: { code: 'E_BUSY', message: 'too many unauthenticated connections' } }); sock.destroy(); return; }
    conns.add(c);
    const hsTimer = setTimeout(() => { if (!c.authed) { log(`dropped connection ${c.id} (no hello within ${handshakeMs} ms)`); send({ error: { code: 'E_AUTH', message: 'handshake timeout' } }); sock.destroy(); } }, handshakeMs);
    hsTimer.unref?.();
    sock.on('close', () => { clearTimeout(hsTimer); conns.delete(c); c.emit('close'); });
    lineReader(sock, async (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { send({ error: { code: 'E_PARSE', message: 'invalid JSON' } }); if (!c.authed) sock.destroy(); return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { send({ error: { code: 'E_PARSE', message: 'a message must be a JSON object' } }); if (!c.authed) sock.destroy(); return; }
      const { id, method } = msg;
      const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? msg.params : {};
      if (!c.authed) {
        if (method !== 'hello' || typeof params.token !== 'string' || !safeEqual(params.token, token)) { log(`rejected connection ${c.id} (bad or missing token)`); send({ id, error: { code: 'E_AUTH', message: 'authentication required' } }); sock.destroy(); return; }
        if (params.protocol != null && (typeof params.protocol !== 'number' || params.protocol > PROTOCOL)) { send({ id, error: { code: 'E_PROTOCOL', message: `daemon speaks protocol ${PROTOCOL}` } }); sock.destroy(); return; }
        clearTimeout(hsTimer);
        c.authed = true; c.client = cleanName(params.client);
        log(`connection ${c.id} from ${c.client}`);
        onConnection?.(c);
        send({ id, result: { protocol: PROTOCOL, pid: process.pid, root } });
        return;
      }
      if (typeof method !== 'string') { send({ id, error: { code: 'E_METHOD', message: 'method must be a string' } }); return; }
      try { const result = await onRequest(c, method, params); send({ id, result }); }
      catch (e) { send({ id, error: { code: e.code || 'E_INTERNAL', message: String(e.message || e).slice(0, 2000) } }); }
    }, () => { send({ error: { code: 'E_TOO_BIG', message: 'message exceeds 1 MiB' } }); sock.destroy(); });
  });
  return new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? Object.assign(new Error(`vto: address in use (${address}) – another daemon or a squatter`), { code: 'EADDRINUSE' }) : e));
    server.listen(address, () => {
      if (process.platform !== 'win32') { try { fs.chmodSync(address, 0o600); } catch {} }
      const ep = { protocol: PROTOCOL, pid: process.pid, address, token, root: slash(root), startedAt: new Date().toISOString() };
      const f = path.join(dir, 'endpoint.json');
      writePrivate(f, JSON.stringify(ep)); // private dir, O_EXCL temp file, 0600
      resolve({ server, conns, endpoint: ep, close: () => closeServer(server, conns, f, address) });
    });
  });
}

function closeServer(server, conns, epFile, address) {
  for (const c of conns) c.sock.destroy();
  server.close();
  try { const ep = JSON.parse(fs.readFileSync(epFile, 'utf8')); if (ep.pid === process.pid) fs.unlinkSync(epFile); } catch {}
  if (process.platform !== 'win32') { try { fs.unlinkSync(address); } catch {} if (path.basename(path.dirname(address)).startsWith('vto-')) { try { fs.rmdirSync(path.dirname(address)); } catch {} } }
}

// ------------------------------------------------------------------ client
export class Client extends EventEmitter {
  constructor(sock) { super(); this.sock = sock; this.seq = 0; this.pending = new Map(); this.closed = false;
    lineReader(sock, (l) => { let m; try { m = JSON.parse(l); } catch { return; } if (m.ev) { this.emit('event', m); return; } const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); m.error ? p.reject(Object.assign(new Error(m.error.message), { code: m.error.code })) : p.resolve(m.result); });
    sock.on('close', () => { this.closed = true; for (const p of this.pending.values()) p.reject(new Error('daemon connection closed')); this.pending.clear(); this.emit('close'); });
    sock.on('error', () => {});
  }
  call(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('daemon connection closed'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.sock.write(JSON.stringify({ id, method, params }) + '\n'); });
  }
  close() { this.sock.end(); }
}

export function connectTo(ep, { client = 'vto', timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(ep.address);
    const t = setTimeout(() => { sock.destroy(); reject(new Error('connect timeout')); }, timeoutMs);
    sock.once('error', (e) => { clearTimeout(t); reject(e); });
    sock.once('connect', async () => {
      clearTimeout(t);
      const c = new Client(sock);
      try { const hello = await c.call('hello', { token: ep.token, protocol: PROTOCOL, client }); c.hello = hello; resolve(c); }
      catch (e) { reject(e); }
    });
  });
}

/** O_EXCL lock for "start the daemon lazily" (stale after 30 s or when the owner died). */
export function acquireStartLock(root) {
  const f = path.join(ensurePrivateDir(endpointDir(root)), 'start.lock');
  for (let i = 0; i < 2; i++) {
    try { const fd = fs.openSync(f, 'wx', 0o600); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return () => { try { fs.unlinkSync(f); } catch {} }; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = true;
      try { const pid = +fs.readFileSync(f, 'utf8'); const age = Date.now() - fs.statSync(f).mtimeMs; stale = !isAlive(pid) || age > 30000; } catch {}
      if (!stale) return null;
      try { fs.unlinkSync(f); } catch {}
    }
  }
  return null;
}
