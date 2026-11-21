// vto verify – Vite plugin: replaces each planned source file by its mutant schemata module.
// Plan: { files: { "/abs/src/x.tsx": [mutant, ...] } } (mutants carry global ids).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { applySchemata } from './mutate.mjs';

export default function vtoMutants(plan, { onMismatch } = {}) {
  const files = new Map(Object.entries(plan.files || {}));
  // name includes a hash of the plan: Vitest's fsModuleCache keys on plugin names, so a schemata
  // module is never served to a run with a different mutant set (or to a plain run).
  const hash = createHash('sha1').update(JSON.stringify(plan.files || {})).digest('hex').slice(0, 10);
  return {
    name: `vto:mutants@${hash}`,
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0];
      const ms = files.get(file);
      if (!ms) return;
      let disk;
      try { disk = readFileSync(file, 'utf8'); } catch { disk = null; }
      if (disk !== code) { // an earlier transform changed the code → positions would be wrong
        onMismatch?.(file);
        this.warn(`vto verify: ${file} was transformed before vto (positions differ) – its mutants are skipped`);
        return;
      }
      const r = applySchemata(code, file, ms);
      return { code: r.code, map: r.map };
    },
  };
}
