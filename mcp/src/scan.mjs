// Change detection without file watchers: stat (mtime+size) → hash only when the stat changed.
// Works identically on Linux, macOS and Windows (no fs.watch recursion differences, no inotify
// limits); used before every selection and, during runs, by the fix loop (polling ~0.7 s, only the
// files covered by already-failed tests).
import fs from 'node:fs';
import { contentHash } from './paths.mjs';

export class Scanner {
  constructor() { this.cache = new Map(); } // abs → {sig, sha}
  /** → {sha, text} | null (missing). text only when read now. */
  read(f) {
    let st;
    try { st = fs.statSync(f); } catch { this.cache.delete(f); return null; }
    if (!st.isFile()) return null;
    const sig = `${st.mtimeMs}:${st.size}`;
    const c = this.cache.get(f);
    if (c && c.sig === sig) return { sha: c.sha };
    let buf;
    try { buf = fs.readFileSync(f); } catch { return null; }
    const sha = contentHash(buf); // contracts/DECISIONS.md D1 (bytes; BOM and CRLF do not count)
    this.cache.set(f, { sig, sha });
    return { sha, text: buf.toString('utf8') };
  }
  /** with text always */
  readText(f) {
    try { const buf = fs.readFileSync(f); return { sha: contentHash(buf), text: buf.toString('utf8') }; } catch { return null; }
  }
  /** cheap "did the stat change since the last call" for polling */
  statChanged(f) {
    let sig;
    try { const st = fs.statSync(f); sig = `${st.mtimeMs}:${st.size}`; } catch { sig = 'gone'; }
    const k = '#' + f;
    const prev = this.cache.get(k)?.sig;
    this.cache.set(k, { sig });
    return prev !== undefined && prev !== sig;
  }
}

/** Run-all triggers (MCP.md): config, package manifests, lockfiles, tsconfig, setup files, .env*, vitest-guard lists. */
export function triggerFiles(root, info = {}) {
  const out = new Set();
  const add = (f) => { if (f) out.add(f.replace(/\\/g, '/')); };
  let names = [];
  try { names = fs.readdirSync(root); } catch {}
  for (const n of names) {
    if (/^(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|tsconfig.*\.json|\.gitattributes|(vite|vitest)(\.[\w-]+)?\.config\.[cm]?[jt]s)$/.test(n)) add(`${root}/${n}`);
  }
  const envDir = info.envDir || root;
  try { for (const n of fs.readdirSync(envDir)) if (/^\.env(\..*)?$/.test(n)) add(`${envDir}/${n}`); } catch {}
  add(info.configFile);
  for (const s of info.setupFiles || []) add(s);
  add(`${root}/.vitest-guard/incompatible.json`);
  add(`${root}/.vitest-guard/conflicts.json`);
  return [...out];
}
