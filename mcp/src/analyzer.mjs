// Rust analyzer (`vto`) as a child process: `vto affected <map> --diff - --json` and `vto <map> --out`.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzerCandidates } from './platform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.resolve(here, '../analyzer-manifest.json');
let cached = null;
export function _resetAnalyzer() { cached = null; }

const sha256File = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

/**
 * Which analyzer binary runs (SECURITY N1a). Never a path the project under test controls:
 * the project's node_modules, PATH and the current directory are not searched.
 *  - VTO_ANALYZER: explicit user configuration (environment, outside the repository); must be absolute
 *  - @vto/analyzer-<platform>-<arch> resolved from vto's OWN installation only; the binary's sha256
 *    must equal the hash pinned in analyzer-manifest.json shipped inside vto-mcp (a hash stored in
 *    the binary's own package proves nothing) – a missing pin is a refusal, not a pass
 *  - development: the cargo build of this checkout (only when vto does not live in node_modules)
 * `opts` is for tests (candidates, manifest, require).
 */
export function resolveAnalyzer(opts = {}) {
  if (typeof opts === 'string') opts = {}; // old signature resolveAnalyzer(projectRoot): the project is never consulted
  const useCache = !Object.keys(opts).length;
  if (useCache && cached) return cached;
  const cands = opts.candidates || analyzerCandidates({ here: opts.here || here, env: opts.env || process.env });
  const req = opts.require || createRequire(import.meta.url);
  let manifest = opts.manifest;
  const pins = () => { if (manifest === undefined) { try { manifest = JSON.parse(readFileSync(opts.manifestFile || MANIFEST, 'utf8')); } catch { manifest = null; } } return manifest?.binaries || {}; };
  const problems = [];
  for (const c of cands) {
    if (c.env) {
      if (!path.isAbsolute(c.env)) throw new Error('VTO_ANALYZER must be an absolute path (relative paths would be looked up in the project directory)');
      if (!existsSync(c.env)) throw new Error(`VTO_ANALYZER points to a missing file: ${c.env}`);
      return done(c.env);
    }
    if (c.dev) { if (existsSync(c.dev)) return done(c.dev); continue; }
    let pj;
    try { pj = req.resolve(`${c.pkg}/package.json`); } catch { continue; }
    const f = path.join(path.dirname(pj), c.file);
    if (!existsSync(f)) continue;
    let version = '?';
    try { version = JSON.parse(readFileSync(pj, 'utf8')).version; } catch {}
    const want = pins()[c.pkg]?.[version]?.sha256 ?? (pins()[c.pkg]?.version === version ? pins()[c.pkg].sha256 : undefined);
    if (!want) { problems.push(`${c.pkg}@${version}: no sha256 pinned in vto-mcp's analyzer-manifest.json – refusing an unverified binary`); continue; }
    if (sha256File(f) !== want) throw new Error(`${c.pkg}@${version}: binary hash does not match vto-mcp's analyzer-manifest.json – reinstall vto`);
    return done(f);
  }
  throw new Error(`vto analyzer binary not found${problems.length ? ` (${problems.join('; ')})` : ''}: set VTO_ANALYZER to an absolute path, install the matching @vto/analyzer-<platform>-<arch> release, or \`cargo build --release\` in analyzer/`);
  function done(f) { if (useCache) cached = f; return f; }
}

function run(bin, args, { input, cwd, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, windowsHide: true, shell: false });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => { p.kill(); reject(new Error(`analyzer timeout: ${args.join(' ')}`)); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    // the analyzer may exit before reading stdin (e.g. it rejects the map): EPIPE must not crash the daemon
    p.stdin.on('error', () => {});
    p.stdout.on('error', () => {});
    p.stderr.on('error', () => {});
    if (input != null) p.stdin.end(input); else p.stdin.end();
  });
}

/** → {runAll, reasons, tests:[{id,file,line,name}], warnings} */
export async function affected(root, mapDir, diffText, { importers = false } = {}) {
  const bin = resolveAnalyzer();
  // --allow-stale: the diff is computed against the exact file versions the map recorded
  // (.vto/blobs), not against a git commit, so the analyzer's gitHead/dirty-tree guard does not apply
  const args = ['affected', mapDir, '--diff', '-', '--allow-stale', '--root', root, '--json', ...(importers ? ['--importers'] : [])];
  // fail safe: ANY analyzer problem (spawn error, crash, rejected map, bad JSON) ⇒ run all, with its stderr as reason
  let r;
  try { r = await run(bin, args, { input: diffText, cwd: root }); }
  catch (e) { return failSafe(`analyzer could not run: ${e.message}`); }
  let j = null;
  try { j = JSON.parse(r.out); } catch {}
  if ((r.code !== 0 && r.code !== 3) || !j || !Array.isArray(j.tests ?? [])) {
    return failSafe(`analyzer failed (exit ${r.code})${r.err.trim() ? ': ' + r.err.trim().split('\n').slice(-3).join(' | ').slice(0, 400) : ''}`);
  }
  j.warnings = r.err.split('\n').filter((l) => /warn/i.test(l)).slice(0, 5);
  return j;
}

function failSafe(reason) { return { runAll: true, reasons: [reason], tests: [], warnings: [], analyzerError: true }; }

/** Full overlap/imports report into outDir; returns parsed report.json. */
export async function report(root, mapDir, outDir) {
  const bin = resolveAnalyzer();
  const r = await run(bin, [mapDir, '--out', outDir, '--root', root, '--quiet'], { cwd: root, timeoutMs: 300000 });
  if (r.code !== 0) throw new Error(`analyzer report failed (${r.code}): ${r.err.trim().slice(0, 500)}`);
  return JSON.parse(readFileSync(path.join(outDir, 'report.json'), 'utf8'));
}
