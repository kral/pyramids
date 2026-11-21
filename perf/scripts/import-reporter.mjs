// Custom Vitest reporter: aggregates experimental.importDurations across all test files.
import fs from 'node:fs';
export default class ImportReporter {
  onInit(v) { this.v = v; }
  onTestRunEnd(testModules) {
    const agg = new Map();
    for (const m of testModules) {
      const d = m.diagnostic().importDurations || {};
      for (const [id, x] of Object.entries(d)) {
        const a = agg.get(id) ?? { id, files: 0, self: 0, total: 0, external: x.external };
        a.files++; a.self += x.selfTime; a.total += x.totalTime; agg.set(id, a);
      }
    }
    const out = process.env.IMPORT_OUT || 'import-durations.json';
    fs.writeFileSync(out, JSON.stringify([...agg.values()].sort((a,b)=>b.self-a.self), null, 1));
  }
}
