// Spawns Vitest (the project's own copy) with a JSON reporter and normalises the result.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
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
  const argv = [vitestBin(root), 'run', ...(config ? ['--config', config] : []), '--reporter=json', `--outputFile=${out}`, ...(verbose ? ['--reporter=default'] : []), '--passWithNoTests', ...args, ...files];
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
          for (const t of f.assertionResults) tests.set([...t.ancestorTitles, t.title].join(' > '), t.status);
          const failedTest = f.assertionResults.find((t) => t.status === 'failed');
          res.files.set(rel, { status: f.status === 'passed' ? 'passed' : f.assertionResults.length && f.assertionResults.every((t) => t.status !== 'failed') && !f.message ? 'passed' : 'failed', tests, message: f.message || failedTest?.failureMessages?.[0] || '' });
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

/** Normalised error signature: first meaningful line without paths, numbers, ports and ANSI. */
export function signature(msg = '') {
  const line = msg.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('at ')) || '';
  return line.replace(/(file:\/\/)?\/[^\s'")]+/g, '<path>').replace(/\b\d+(\.\d+)?\b/g, 'N').slice(0, 200);
}
