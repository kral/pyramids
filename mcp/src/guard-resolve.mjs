// Which vitest-guard does vto use for a project? Prefer the project's installed @jirikral/vitest-guard (the copy that
// wraps the user's config) over the checkout's sibling copy, and refuse a protocol mismatch between them.
// "Protocol" = `vitestGuardProtocol` in vitest-guard/package.json: the implicit contract between the CLI/envstore side
// and the config wrapper (VITEST_GUARD_* env, provide.vitestGuard, run logs, auto.json, modes.json, verify-*.json).
// Bump it in vitest-guard when any of those changes incompatibly; vto compares it with GUARD_PROTOCOL below.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const GUARD_PROTOCOL = 1;
const here = path.dirname(fileURLToPath(import.meta.url));
export const CHECKOUT_GUARD_DIR = path.resolve(here, '../../vitest-guard');
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

function readPkg(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; } }
export function protocolOf(dir) { const p = readPkg(dir); return p && Number.isInteger(p.vitestGuardProtocol) ? p.vitestGuardProtocol : null; }

/** directory of the @jirikral/vitest-guard installed in the project (or null) */
export function projectGuardDir(root) {
  try { return path.dirname(createRequire(path.join(path.resolve(root), 'package.json')).resolve('@jirikral/vitest-guard/package.json')); } catch { return null; }
}

/**
 * -> { dir, source: 'project' | 'checkout' | null, version, protocol }; throws an Error with a clear message when the
 * chosen copy speaks another protocol than this vto (never silently misreads its logs and state).
 */
export function resolveGuard(root, { expected = GUARD_PROTOCOL } = {}) {
  const proj = projectGuardDir(root);
  const dir = proj && fs.existsSync(path.join(proj, 'src', 'index.mjs')) ? proj : fs.existsSync(path.join(CHECKOUT_GUARD_DIR, 'src', 'index.mjs')) ? CHECKOUT_GUARD_DIR : null;
  if (!dir) return { dir: null, source: null, version: null, protocol: null };
  const source = real(dir) === real(CHECKOUT_GUARD_DIR) || dir === CHECKOUT_GUARD_DIR ? (proj ? 'project' : 'checkout') : 'project';
  const protocol = protocolOf(dir), version = readPkg(dir)?.version ?? 'unknown';
  if (protocol !== expected) {
    throw new Error(`vitest-guard protocol mismatch: this vto expects protocol ${expected}, but the ${source} copy of @jirikral/vitest-guard ${version} (${dir}) speaks ${protocol ?? 'none (older than 0.1.0-alpha.3)'}. ` +
      `Install a matching version in the project (npm i -D @jirikral/vitest-guard@next) or update vto.`);
  }
  return { dir, source, version, protocol };
}
