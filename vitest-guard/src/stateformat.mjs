// Format versions of the state files (architecture review 3 B2, contracts/DECISIONS.md D3).
// A missing `version` counts as 1 (hand-written files). Unknown fields are kept (load/save round-trips the object);
// a HIGHER version than this vitest-guard understands is refused: the CLI exits 2 before running anything, the config
// wrapper warns and fails safe (every file named in a newer incompatible.json runs isolated).
import fs from 'node:fs';

/** files a team may commit (incompatible/conflicts always, durations/pollution with --commit-state) */
export const STATE_VERSIONS = { 'incompatible.json': 1, 'conflicts.json': 1, 'pollution.json': 1, 'durations.json': 1 };
/** volatile files in .vitest-guard/run/ with a version: a newer one is ignored (re-created), never misread */
export const VOLATILE_VERSIONS = { 'plan.json': 2 };

const PKG = (() => { try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')); } catch { return { name: '@jirikral/vitest-guard', version: '0.0.0' }; } })();

export class StateVersionError extends Error {
  constructor(msg) { super(msg); this.name = 'StateVersionError'; this.code = 'E_STATE_VERSION'; }
}

/** The file's format version: 1 when missing, NaN when not a positive integer. */
export function versionOf(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj.version === undefined) return 1;
  return Number.isInteger(obj.version) && obj.version >= 1 ? obj.version : NaN;
}

/** null when `obj` (contents of state file `name`) can be used, otherwise the reason. */
export function versionProblem(name, obj, label = name) {
  const max = STATE_VERSIONS[name] ?? VOLATILE_VERSIONS[name];
  if (!max) return null;
  const v = versionOf(obj);
  if (v <= max) return null;
  const shown = Number.isNaN(v) ? JSON.stringify(obj.version).slice(0, 40) : v;
  return `${label} has format version ${shown}; this ${PKG.name} (${PKG.version}) understands version ${max} - upgrade ${PKG.name}`;
}

/** Throw StateVersionError when `obj` has a newer (or invalid) version. */
export function assertStateVersion(name, obj, label) {
  const p = versionProblem(name, obj, label);
  if (p) throw new StateVersionError(`[vitest-guard] ${p}`);
  return obj;
}

/** Copy of `obj` stamped with the current version (version first), for the writers. */
export function stamp(name, obj) {
  const v = STATE_VERSIONS[name];
  if (!v || !obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  return Object.assign({ version: v }, obj, { version: v });
}
