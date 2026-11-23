// "Has the fast mode been compared with isolated forks for what is checked out now?" (REVIEW-2-correctness M6)
// `vitest-guard verify` records its result with the current commit and a hash of everything that decides how tests are
// routed; defineVitestGuardConfig warns when a shared-mode `vitest run` has no matching clean record.
// No Vitest import, no child process: this runs at config time.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CONFIG_NAMES = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.cts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs',
  'vite.config.ts', 'vite.config.mts', 'vite.config.cts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs'];

/** Config file Vitest would load: `--config`/`-c` from argv when given, else the first existing default name. */
export function findConfigFile(root, argv = []) {
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    const m = /^(?:--config|-c)=(.+)$/.exec(a);
    const v = m ? m[1] : (a === '--config' || a === '-c') && argv[i + 1] ? String(argv[i + 1]) : null;
    if (v) return path.resolve(root, v);
  }
  return CONFIG_NAMES.map((f) => path.join(root, f)).find((f) => fs.existsSync(f)) || null;
}

/** HEAD commit without spawning git (reads .git/HEAD, refs, packed-refs; worktrees via the `gitdir:` file). */
export function gitHead(root) {
  try {
    let dir = path.resolve(root), git = null;
    for (let i = 0; i < 64; i++) { const g = path.join(dir, '.git'); if (fs.existsSync(g)) { git = g; break; } const up = path.dirname(dir); if (up === dir) break; dir = up; }
    if (!git) return null;
    if (fs.statSync(git).isFile()) { const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(git, 'utf8')); if (!m) return null; git = path.resolve(dir, m[1].trim()); }
    const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
    const sha = (s) => (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(s) ? s : null);
    const m = /^ref:\s*(.+)$/.exec(head);
    if (!m) return sha(head);
    const ref = m[1].trim();
    if (!/^refs\/[\w./-]+$/.test(ref) || ref.includes('..')) return null;
    let common = git;
    try { common = path.resolve(git, fs.readFileSync(path.join(git, 'commondir'), 'utf8').trim()); } catch {}
    for (const g of [git, common]) { try { const s = sha(fs.readFileSync(path.join(g, ref), 'utf8').trim()); if (s) return s; } catch {} }
    try { for (const l of fs.readFileSync(path.join(common, 'packed-refs'), 'utf8').split('\n')) { const [s, r] = l.split(' '); if (r === ref && sha(s)) return s; } } catch {}
    return null;
  } catch { return null; }
}

/** Hash of what decides which test runs where: the config file, the quarantine and the conflict edges. */
export function configKey(root, configFile, quarantineFile = '.vitest-guard/incompatible.json') {
  const h = crypto.createHash('sha256');
  for (const f of [configFile, path.resolve(root, quarantineFile), path.join(root, '.vitest-guard', 'conflicts.json')]) {
    h.update('\0');
    if (!f) continue;
    try { h.update(path.basename(f) + '\0'); h.update(fs.readFileSync(f)); } catch { h.update('-'); }
  }
  return h.digest('hex').slice(0, 32);
}

export const verifyFile = (root, mode) => path.join(root, '.vitest-guard', 'run', `verify-${mode}.json`);

/**
 * @returns {{ ok: boolean, reason?: string, record?: object }} ok = a complete, clean verify exists for this
 * commit and this config/quarantine state.
 */
export function verifyStatus(root, mode, { configFile = findConfigFile(root), quarantineFile, configMode } = {}) {
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(verifyFile(root, mode), 'utf8')); } catch {}
  if (!rec || typeof rec !== 'object') return { ok: false, reason: 'no verify run has been recorded' };
  if (Array.isArray(rec.falseGreen) && rec.falseGreen.length) return { ok: false, record: rec, reason: `the last verify (${rec.at}) found ${rec.falseGreen.length} false green(s)` };
  // N5: a verify that skipped default orders (e.g. --orders gate) did not put every pair of files in both orders
  // (vm on Vitest < 5 skips its single-worker orders on purpose: every file runs in a fresh worker there)
  const need = (rec.mode === 'vm' ? ['gate', 'reversed'] : ['gate', 'forward', 'reversed']).filter((x) => !(rec.mode === 'vm' && x !== 'gate' && Array.isArray(rec.ordersSkipped) && rec.ordersSkipped.includes(x)));
  if (Array.isArray(rec.orders) && need.some((x) => !rec.orders.includes(x))) return { ok: false, record: rec, reason: `the last verify (${rec.at}) ran only the orders ${rec.orders.join(', ')} (needs ${need.join(', ')})` };
  if (rec.complete === false) return { ok: false, record: rec, reason: `the last verify covered only a sample (${rec.sample} of ${rec.of} files)` };
  if (!rec.configKey || rec.configKey !== configKey(root, configFile, quarantineFile)) return { ok: false, record: rec, reason: `the config or the quarantine changed since the last verify (${rec.at})` };
  const head = gitHead(root);
  if (head && rec.head !== head) return { ok: false, record: rec, reason: `the last verify (${rec.at}) was for commit ${String(rec.head || 'unknown').slice(0, 9)}, HEAD is ${head.slice(0, 9)}` };
  return { ok: true, record: rec };
}
