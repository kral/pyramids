// Process helpers shared by editor + clipboard: PATH lookup and a promise around spawn.
// Never uses a shell. On Windows `.cmd`/`.bat` shims (code.cmd, webstorm.cmd) are run through
// cross-spawn, which escapes cmd.exe metacharacters (CVE-2024-27980 class of issues).
import fs from 'node:fs';
import path from 'node:path';
import crossSpawn from 'cross-spawn';
import type { SpawnOptions, ChildProcess } from 'node:child_process';

export type Env = Record<string, string | undefined>;

export interface ProcDeps {
  platform: NodeJS.Platform;
  env: Env;
  /** spawn implementation (injectable for tests) */
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  exists: (p: string) => boolean;
}

export const defaultDeps = (): ProcDeps => ({
  platform: process.platform,
  env: process.env,
  spawn: (cmd, args, opts) => crossSpawn(cmd, args, opts),
  exists: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
});

/** Locate an executable on PATH (honours PATHEXT on Windows). Returns absolute path or null. */
export function which(name: string, deps: Pick<ProcDeps, 'platform' | 'env' | 'exists'>): string | null {
  const isWin = deps.platform === 'win32';
  const p = isWin ? path.win32 : path.posix;
  if (name.includes('/') || (isWin && name.includes('\\'))) return deps.exists(name) ? name : null;
  const dirs = (deps.env.PATH ?? deps.env.Path ?? '').split(isWin ? ';' : ':').filter(Boolean);
  const exts = isWin ? (deps.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()) : [''];
  const hasExt = isWin && exts.some((e) => name.toLowerCase().endsWith(e));
  for (const d of dirs) {
    for (const e of hasExt ? [''] : exts) {
      const cand = p.join(d.replace(/^"|"$/g, ''), name + e);
      if (deps.exists(cand)) return cand;
    }
  }
  return null;
}

/** Split an $EDITOR value like `code --wait` or `"C:\Program Files\x\y.exe" -n` into argv (no shell expansion). */
export function splitCommandLine(s: string): string[] {
  const out: string[] = [];
  let cur = '', q: string | null = null, any = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === '\\' && q === '"' && (s[i + 1] === '"' || s[i + 1] === '\\') ) cur += s[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") { q = ch; any = true; }
    else if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; }
    else cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

export function runWithInput(deps: ProcDeps, cmd: string, args: string[], input: Buffer | string, env?: Env): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = deps.spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env: env ? { ...deps.env, ...env } as NodeJS.ProcessEnv : undefined });
    } catch (e) { reject(e); return; }
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${cmd}: timeout`)); }, 5000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)); });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}
