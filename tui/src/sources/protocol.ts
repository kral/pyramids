// Daemon IPC protocol "vto-ipc/1" (mcp/src/ipc.mjs, PROTOCOL.md): newline-delimited JSON over a
// Unix domain socket (Linux/macOS) or a named pipe (Windows).
//
//   discovery  <runtimeBase>/<projectKey(root)>/endpoint.json  {protocol, pid, address, token, root}
//              runtimeBase: $XDG_RUNTIME_DIR/vto | ~/.cache/vto/run | ~/Library/Caches/vto/run |
//                           %LOCALAPPDATA%\vto\run ; file must be 0600 and ours (POSIX)
//   client → daemon   {"id":1,"method":"hello","params":{"token":"…","protocol":1,"client":"vto-ui"}}
//                     {"id":2,"method":"subscribe","params":{"topics":["run","test"],"replay":true}}
//                     {"id":3,"method":"rerun_failed","params":{"runId":"r12","ids":["…"]}}
//   daemon → client   {"id":2,"result":{…}} | {"id":3,"error":{"code":"E_…","message":"…"}}
//                     {"ev":"failure",…}   (events: bare objects, as in .vto/runs/<runId>.jsonl)
// Everything protocol-specific lives in this file and in ipc.ts.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeEvent, type VtoEvent } from '../events.js';

export type Decoded =
  | { type: 'event'; ev: VtoEvent }
  | { type: 'response'; id: number | string; result?: unknown; error?: { message: string; code?: string } }
  | { type: 'ignored' };

export function decodeMessage(line: string): Decoded {
  const s = line.trim();
  if (!s || s[0] !== '{') return { type: 'ignored' };
  let o: Record<string, unknown>;
  try { o = JSON.parse(s); } catch { return { type: 'ignored' }; }
  if (typeof o.ev === 'string') { const ev = normalizeEvent(o); return ev ? { type: 'event', ev } : { type: 'ignored' }; }
  if (o.method === 'event' && o.params) { const ev = normalizeEvent(o.params); return ev ? { type: 'event', ev } : { type: 'ignored' }; }
  if ((typeof o.id === 'number' || typeof o.id === 'string') && ('result' in o || 'error' in o)) {
    const err = o.error as { message?: string; code?: string } | string | undefined;
    return {
      type: 'response', id: o.id, result: o.result,
      error: err ? { message: typeof err === 'string' ? err : err.message ?? 'error', code: typeof err === 'object' ? err.code : undefined } : undefined,
    };
  }
  return { type: 'ignored' };
}

export function encodeRequest(id: number, method: string, params: unknown): string {
  return JSON.stringify({ id, method, params }) + '\n';
}

export const PROTOCOL = 1;

const slash = (p: string) => {
  let s = String(p).replace(/\\/g, '/');
  if (/^[a-z]:\//.test(s)) s = s[0].toUpperCase() + s.slice(1);
  if (s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s)) s = s.slice(0, -1);
  return s;
};

/** Same probe as the daemon (inode compare of the case-flipped last segment, else a temp file). */
const ciCache = new Map<string, boolean>();
export function isCaseInsensitiveFs(dir: string): boolean {
  const hit = ciCache.get(dir);
  if (hit !== undefined) return hit;
  let res = false;
  try {
    const real = fs.realpathSync(dir);
    const base = path.basename(real);
    const flipped = [...base].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
    if (flipped !== base) {
      try { const a = fs.statSync(real), b = fs.statSync(path.join(path.dirname(real), flipped)); res = a.ino === b.ino && a.dev === b.dev; } catch { res = false; }
    } else {
      const probe = path.join(real, `.vto-Cp${process.pid}`);
      try { fs.writeFileSync(probe, ''); res = fs.existsSync(path.join(real, `.vto-cP${process.pid}`)); } catch { res = false; } finally { try { fs.unlinkSync(probe); } catch {} }
    }
  } catch { res = false; }
  ciCache.set(dir, res);
  return res;
}

type Env = Record<string, string | undefined>;

function ownedPrivate(d: string): boolean {
  try {
    const s = fs.statSync(d);
    return s.isDirectory() && (process.getuid ? s.uid === process.getuid() : true) && (s.mode & 0o077) === 0;
  } catch { return false; }
}

/** Per-user base directory of daemon endpoints (mirrors mcp/src/ipc.mjs runtimeBase). */
export function runtimeBase(o: { platform?: string; env?: Env; home?: string } = {}): string {
  const platform = o.platform ?? process.platform, env = o.env ?? process.env, home = o.home ?? os.homedir();
  const pp = platform === 'win32' ? path.win32 : path.posix; // the target platform's separators, not the host's
  if (platform === 'win32') return pp.join((env.LOCALAPPDATA && pp.isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : '') || pp.join(home, 'AppData', 'Local'), 'vto', 'run');
  if (env.XDG_RUNTIME_DIR && pp.isAbsolute(env.XDG_RUNTIME_DIR) && ownedPrivate(env.XDG_RUNTIME_DIR)) return pp.join(env.XDG_RUNTIME_DIR, 'vto');
  return pp.join((env.XDG_CACHE_HOME && pp.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : '') || pp.join(home, platform === 'darwin' ? 'Library/Caches' : '.cache'), 'vto', 'run');
}

export function projectKey(root: string, caseInsensitive = isCaseInsensitiveFs(slash(path.resolve(root)))): string {
  const r = slash(path.resolve(root));
  return createHash('sha1').update(caseInsensitive ? r.toLowerCase() : r).digest('hex').slice(0, 16);
}

export function endpointDir(root: string, o?: Parameters<typeof runtimeBase>[0]): string {
  return path.join(runtimeBase(o), projectKey(root));
}

export interface Endpoint { protocol: number; pid: number; address: string; token: string; root: string; startedAt?: string }

export function isAlive(pid: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** endpoint.json of the root's daemon, or null (missing, not ours / not private, daemon dead). */
export function readEndpoint(root: string, o: { checkAlive?: boolean } = {}): Endpoint | null {
  const f = path.join(endpointDir(root), 'endpoint.json');
  try {
    if (process.platform !== 'win32') {
      const s = fs.statSync(f);
      if (process.getuid && s.uid !== process.getuid()) return null;
      if ((s.mode & 0o077) !== 0) return null;
    }
    const ep = JSON.parse(fs.readFileSync(f, 'utf8')) as Endpoint;
    if (!ep?.address || !ep.token) return null;
    if (o.checkAlive !== false && !isAlive(ep.pid)) return null;
    return ep;
  } catch { return null; }
}

/** Project root exactly as the daemon finds it: nearest vitest/vite config, else nearest package.json. */
export function findRoot(start: string): string {
  let d = path.resolve(start);
  let pkg: string | null = null;
  for (;;) {
    let names: string[] = [];
    try { names = fs.readdirSync(d); } catch {}
    if (names.some((n) => /^(vitest|vite)\.config\.[cm]?[jt]s$/.test(n))) return d;
    if (!pkg && names.includes('package.json')) pkg = d;
    const up = path.dirname(d);
    if (up === d) return pkg ?? path.resolve(start);
    d = up;
  }
}

/** Newest `.vto/runs/<runId>.jsonl` (by mtime) or null. */
export function latestRunFile(root: string): string | null {
  const dir = path.join(root, '.vto', 'runs');
  let best: { f: string; m: number } | null = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const m = fs.statSync(path.join(dir, f)).mtimeMs;
      if (!best || m > best.m) best = { f: path.join(dir, f), m };
    }
  } catch { return null; }
  return best?.f ?? null;
}
