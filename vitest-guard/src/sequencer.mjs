// Sequencer that runs files in the order of a vitest-guard plan lane (VITEST_GUARD_LANE_FILE = json list of
// root-relative paths, or { project, files }). With isolate:false + maxWorkers:1 Vitest 5.1.1 batches every file
// of the project into ONE worker run request in sequencer order (groupSpecs in vitest/dist/chunks/index.*.js),
// so the order here is exactly the execution order in the shared worker.
//
// It deliberately does NOT `import 'vitest/node'` statically: when the package is installed through a symlink
// (`npm i -D ../vto/vitest-guard`, workspaces, pnpm link) Node resolves bare imports from the REAL path of this file,
// where there is no `vitest` (or worse: a second copy). Vitest only needs `new Sequencer(ctx)`, `sort` and `shard`;
// without a lane file both delegate to the BaseSequencer of the Vitest copy that is actually running (resolved
// from the project root).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** Import a `vitest/*` entry from the consumer project (never from vitest-guard's own location). */
export async function importFromProject(root, spec) {
  const bases = [path.join(root, 'package.json'), path.join(process.cwd(), 'package.json')];
  let last;
  for (const b of bases) {
    try { return await import(pathToFileURL(createRequire(b).resolve(spec)).href); } catch (e) { last = e; }
  }
  throw new Error(`[vitest-guard] cannot resolve '${spec}' from ${root}: install vitest (>=5.1 <6) in that project. (${last?.message})`);
}

export default class VitestGuardSequencer {
  constructor(ctx) { this.ctx = ctx; this._base = null; }
  async base() {
    if (!this._base) {
      const { BaseSequencer } = await importFromProject(this.ctx?.config?.root || process.cwd(), 'vitest/node');
      this._base = new BaseSequencer(this.ctx);
    }
    return this._base;
  }
  async shard(files) { return (await this.base()).shard(files); }
  async sort(files) {
    const laneFile = process.env.VITEST_GUARD_LANE_FILE;
    if (!laneFile) return (await this.base()).sort(files);
    const raw = JSON.parse(fs.readFileSync(laneFile, 'utf8'));
    const order = Array.isArray(raw) ? raw : Array.isArray(raw?.files) ? raw.files : [];
    const rank = new Map(order.map((f, i) => [f, i]));
    const key = (s) => { const r = path.relative(s.project.config.root, s.moduleId).split(path.sep).join('/'); return rank.has(r) ? rank.get(r) : 1e9; };
    return [...files].sort((a, b) => key(a) - key(b));
  }
}
