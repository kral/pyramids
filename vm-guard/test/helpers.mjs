// Shared helpers of the vm-guard tests.
// Integration tests spawn the real Vitest from this package's devDependencies. They are NOT skipped when it is
// missing: a skipped test counts as a pass in CI (REVIEW-2-architecture N8). Run `npm ci` first, or opt out
// explicitly with VM_GUARD_TEST_NO_INTEGRATION=1 (then they are reported as skipped with that reason).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const pkgDir = path.join(here, '..');
export const cliBin = path.join(pkgDir, 'bin', 'vm-guard.mjs');
export const indexFile = path.join(pkgDir, 'src', 'index.mjs');
const require = createRequire(import.meta.url);

export const optedOut = process.env.VM_GUARD_TEST_NO_INTEGRATION === '1';
let modulesDir = null, missing = null;
try { modulesDir = path.dirname(path.dirname(require.resolve('vitest/package.json'))); } catch { missing = 'vitest'; }
if (modulesDir) { try { require.resolve('jsdom'); } catch { missing = 'jsdom'; } }
export const vitestDir = missing ? null : modulesDir;
if (missing && !optedOut) throw new Error(`vm-guard tests need ${missing} (devDependency): run \`npm ci\` in vm-guard/. To run only the unit tests set VM_GUARD_TEST_NO_INTEGRATION=1.`);
/** node:test options for tests that spawn Vitest */
export const integration = { skip: optedOut ? 'VM_GUARD_TEST_NO_INTEGRATION=1' : false };

/** Temp project. node_modules: 'link' = one symlink to our node_modules, 'real' = a real dir with one symlink per package (lets a test add its own packages). */
export function project(files, { modules = 'link', prefix = 'vmg-test-' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  if (vitestDir && modules === 'link') fs.symlinkSync(vitestDir, path.join(root, 'node_modules'));
  if (vitestDir && modules === 'real') {
    fs.mkdirSync(path.join(root, 'node_modules'));
    for (const n of fs.readdirSync(vitestDir)) {
      if (n.startsWith('.')) continue;
      if (n.startsWith('@')) { fs.mkdirSync(path.join(root, 'node_modules', n)); for (const m of fs.readdirSync(path.join(vitestDir, n))) fs.symlinkSync(path.join(vitestDir, n, m), path.join(root, 'node_modules', n, m)); }
      else fs.symlinkSync(path.join(vitestDir, n), path.join(root, 'node_modules', n));
    }
  }
  for (const [f, src] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), src); }
  return root;
}

/** A config wrapped with defineVmGuardConfig (imports this checkout by path). */
export const wrappedConfig = (test, guard = {}) => `import { defineVmGuardConfig } from ${JSON.stringify(indexFile)};
// the temp project links node_modules from outside its root: let Vite serve it (real installs live inside the root)
export default defineVmGuardConfig({ server: { fs: { strict: false } }, test: ${JSON.stringify(test)} }, ${JSON.stringify(guard)});\n`;

const cleanEnv = () => { const e = { ...process.env }; for (const k of Object.keys(e)) if (k.startsWith('VM_GUARD_') && k !== 'VM_GUARD_TEST_NO_INTEGRATION') delete e[k]; return e; };

/** Run the vm-guard CLI in `root`. */
export function cli(root, args, { env = {}, bin = cliBin } = {}) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: root, env: { ...cleanEnv(), ...env }, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout, stderr: r.stderr };
}

/** Plain `vitest run` in `root` (what a CI gate runs). */
export function vitestRun(root, args = [], { env = {} } = {}) {
  const out = path.join(root, `.report-${process.pid}-${Date.now()}.json`);
  const r = spawnSync(process.execPath, [path.join(vitestDir, 'vitest', 'vitest.mjs'), 'run', '--reporter=json', `--outputFile=${out}`, ...args], { cwd: root, env: { ...cleanEnv(), ...env }, encoding: 'utf8', maxBuffer: 64 << 20 });
  const status = {};
  try { for (const f of JSON.parse(fs.readFileSync(out, 'utf8')).testResults) status[path.relative(root, f.name).split(path.sep).join('/')] = f.status; } catch {}
  try { fs.rmSync(out); } catch {}
  return { code: r.status, out: r.stdout + r.stderr, status };
}
export const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
