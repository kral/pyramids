// Spawns Vitest (the project's own copy) with a JSON reporter and normalises the result.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privateTmp, readOwnedFile } from './safety.mjs';

export function vitestBin(root) {
  const rq = createRequire(path.join(root, 'package.json'));
  // always the PROJECT's Vitest, never one next to vitest-guard (symlinked installs, monorepos)
  let pkg;
  try { pkg = rq.resolve('vitest/package.json'); } catch { throw new Error(`vitest is not installed in ${root} (vitest-guard needs the project's own vitest >=5.1 <6: npm i -D vitest)`); }
  return path.join(path.dirname(pkg), 'vitest.mjs');
}

/**
 * @returns {Promise<{code:number, files: Map<string,{status:string, tests: Map<string,string>, message?:string}>, cpu?:number, wallMs:number, log:string}>}
 */
export function runVitest({ root, config, mode, files = [], laneFile, args = [], env = {}, verbose = false, tag = 'run' }) {
  // F8: report in a fresh private 0700 dir (unpredictable name), read back without following symlinks
  const tmp = privateTmp();
  const out = tmp.file(`${tag}.json`);
  const argv = [vitestBin(root), 'run', ...(config ? ['--config', config] : []), '--reporter=json', `--outputFile=${out}`, ...(verbose ? ['--reporter=default'] : []), '--passWithNoTests', '--bail=0', ...args, ...files]; // S6: a user `bail` must not truncate a comparison
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: root, env: { ...process.env, VITEST_GUARD_DIAG: process.env.VITEST_GUARD_DIAG ?? '1', VITEST_GUARD_CLI: '1', ...env, ...(mode ? { VITEST_GUARD_MODE: mode } : {}), ...(laneFile ? { VITEST_GUARD_LANE_FILE: laneFile } : {}) }, stdio: verbose ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout?.on('data', (d) => (log += d));
    child.stderr?.on('data', (d) => (log += d));
    child.on('close', (code) => {
      const res = { code: code ?? 1, files: new Map(), wallMs: Date.now() - t0, log };
      try {
        const j = JSON.parse(readOwnedFile(out));
        for (const f of j.testResults) {
          const rel = path.relative(root, f.name).split(path.sep).join('/');
          const tests = new Map();
          // B7: duplicate full names (test.each without placeholders) get an occurrence suffix instead of overwriting each other
          for (const t of f.assertionResults) { const name = [...t.ancestorTitles, t.title].join(' > '); let k = name; for (let i = 2; tests.has(k); i++) k = `${name} #${i}`; tests.set(k, t.status); }
          const failedTest = f.assertionResults.find((t) => t.status === 'failed');
          // N8: Vitest marks the file failed when a hook of a nested suite throws although every test passed
          const status = f.status === 'passed' ? 'passed' : f.status !== 'failed' && f.assertionResults.length && f.assertionResults.every((t) => t.status !== 'failed') && !f.message ? 'passed' : 'failed';
          const entry = { status, tests, message: f.message || failedTest?.failureMessages?.[0] || (status === 'failed' ? 'failed outside any test (a suite hook?)' : '') };
          // S1: the same file in two projects: fold pessimistically (failed if any project's run failed, per test too)
          const prev = res.files.get(rel);
          if (prev) {
            for (const [t, st] of tests) { const p0 = prev.tests.get(t); if (p0 === undefined || (p0 === 'passed' && st !== 'passed') || (p0 !== 'failed' && st === 'failed')) prev.tests.set(t, st); }
            if (prev.status === 'passed' && entry.status !== 'passed') { prev.status = entry.status; prev.message = entry.message; }
          } else res.files.set(rel, entry);
        }
      } catch (e) { res.error = 'no JSON report: ' + e.message; }
      tmp.cleanup();
      resolve(res);
    });
  });
}

/**
 * CPU seconds consumed by already-waited child processes of this process (Linux: cutime + cstime from
 * /proc/self/stat, which include the children's own waited children, e.g. Vitest fork workers; threads are part
 * of their process). null where /proc is unavailable.
 */
export function childCpuSeconds() {
  try {
    const st = fs.readFileSync('/proc/self/stat', 'utf8');
    const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
    return (Number(f[13]) + Number(f[14])) / 100; // fields 16/17, clock ticks (CLK_TCK = 100 on Linux)
  } catch { return null; }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** literal directory `dir` with either separator, optionally as a file:// URL, followed by the rest of the path */
const under = (dir) => {
  const parts = dir.replace(/[\\/]+$/, '').split(/[\\/]+/).map(esc);
  return new RegExp(`(?:file:\\/\\/\\/?)?${parts.join('[\\\\/]+')}(?:[\\\\/]+([^\\s'")]*))?(?![^\\s\\\\/'")])`, /^[a-z]:|^\\\\/i.test(dir) || process.platform === 'win32' ? 'gi' : 'g');
};
const END = `[^\\s'")]*`;
/**
 * Normalised error signature: first meaningful line without absolute paths, user names, numbers, ports and ANSI.
 * It goes into the committed incompatible.json / conflicts.json, so it must be the same on every machine
 * (architecture review 3 S4): paths inside `root` become root-relative with `/`; every other absolute path
 * (POSIX, `C:\\…`, `C:/…`, UNC `\\\\server\\share`, file:// URLs, home directories even with spaces) becomes <path>.
 */
export function signature(msg = '', { root = process.cwd(), home = os.homedir() } = {}) {
  let line = String(msg).replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('at ')) || '';
  if (root && root.length > 1) line = line.replace(under(root), (m, rest) => (rest ? rest.replace(/\\/g, '/') : '.'));
  line = line.replace(new RegExp(`(?:file:\\/\\/\\/?)?(?:[A-Za-z]:)?[\\\\/]+(?:Users|home|Documents and Settings)[\\\\/]+[^\\\\/\\n'"]+${END}`, 'gi'), '<path>'); // user dirs, names with spaces
  if (home && home.length > 1) line = line.replace(under(home), '<path>'); // homes elsewhere (/root, /var/lib/ci, …)
  line = line
    .replace(new RegExp(`file:\\/\\/${END}`, 'gi'), '<path>')
    .replace(new RegExp(`(?<![\\w.~<>-])(?:\\\\\\\\[^\\s\\\\'")]+\\\\${END}|[A-Za-z]:[\\\\/]${END}|\\/[^\\s'")]+)`, 'g'), '<path>'); // UNC, drive, POSIX
  return line.replace(/\b\d+(\.\d+)?\b/g, 'N').slice(0, 200);
}
