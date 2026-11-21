// Contract daemon ↔ analyzer: the map the engine writes must be accepted by the analyzer binary that is
// built from this repo (VTO_ANALYZER in CI = freshly built), and any analyzer failure must degrade to
// "run all" with the analyzer's message – never crash (VALIDATION-real-suite D1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.mjs';
import { dispatch } from '../src/api.mjs';
import * as analyzer from '../src/analyzer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixture');
const nm = [path.join(fixture, 'node_modules'), process.env.VTO_TEST_NODE_MODULES, '/home/claude/demo/node_modules'].find((p) => p && fs.existsSync(path.join(p, 'vitest')));
let bin = null; try { bin = analyzer.resolveAnalyzer(); } catch {}
const skip = !nm ? 'no node_modules for the fixture' : !bin ? 'no analyzer binary (build analyzer/ or set VTO_ANALYZER)' : false;

function copyFixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-ct-'));
  fs.cpSync(fixture, d, { recursive: true, filter: (s) => !s.includes('node_modules') && !s.includes(`${path.sep}.vto`) });
  fs.symlinkSync(nm, path.join(d, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return d;
}

test('the stored map is accepted by the analyzer (affected + report), file names w-*/s-* only', { skip, timeout: 120000 }, async () => {
  const root = copyFixture();
  const eng = await new Engine(root).init();
  try {
    const r = await eng.waitRun((await dispatch(eng, 'start_run', {})).runId);
    assert.equal(r.failed, 0);
    assert.equal(r.total, r.ran, 'D2: total filled on the first run');
    assert.ok(r.mapUpdated.files >= 5, `D2: recorded files counted (${r.mapUpdated.files})`);
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [e.name]));
    for (const n of walk(eng.store.mapDir)) assert.match(n, /^[ws]-.*\.jsonl$/, n);
    const p = path.join(root, 'src/price.ts');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('total *= 0.8', 'total *= 0.7'));
    const a = await dispatch(eng, 'affected', {});
    assert.equal(a.runAll, false, JSON.stringify(a));
    assert.ok(a.count > 0 && a.count < a.total);
    const rep = await analyzer.report(root, eng.store.mapDir, path.join(root, '.vto', 'report'));
    assert.ok(Array.isArray(rep.tests) && rep.tests.length === eng.store.testCount());
  } finally { await eng.close(); }
});

test('a map of another state version is discarded LOUDLY (run all with the reason), never silently', { skip, timeout: 120000 }, async () => {
  const root = copyFixture();
  let eng = await new Engine(root).init();
  await eng.waitRun((await dispatch(eng, 'start_run', {})).runId);
  await eng.close();
  const sf = path.join(root, '.vto', 'state.json');
  fs.writeFileSync(sf, JSON.stringify({ ...JSON.parse(fs.readFileSync(sf, 'utf8')), version: 1 }));
  eng = await new Engine(root).init();
  try {
    assert.equal(eng.store.testCount(), 0);
    const a = await dispatch(eng, 'affected', {});
    assert.equal(a.runAll, true);
    assert.match(a.reasons.join(' | '), /state version \(1 → 2\) was discarded/);
  } finally { await eng.close(); }
});

test('analyzer that exits early (no stdin read) → run all with its message, no EPIPE crash', { skip: process.platform === 'win32' ? 'shebang scripts' : skip, timeout: 60000 }, async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-fake-'));
  const fake = path.join(d, 'vto');
  fs.writeFileSync(fake, '#!/usr/bin/env node\nprocess.stderr.write("vto: raw data rejected: map: no w-*.jsonl / s-*.jsonl files\\n"); process.exit(2);\n');
  fs.chmodSync(fake, 0o755);
  const prev = process.env.VTO_ANALYZER;
  process.env.VTO_ANALYZER = fake; analyzer._resetAnalyzer();
  try {
    const big = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'.repeat(20000); // > pipe buffer
    const r = await analyzer.affected(d, d, big);
    assert.equal(r.runAll, true);
    assert.match(r.reasons[0], /rejected/);
    process.env.VTO_ANALYZER = path.join(d, 'missing'); analyzer._resetAnalyzer();
    fs.writeFileSync(path.join(d, 'missing'), ''); // not executable
    const r2 = await analyzer.affected(d, d, 'x');
    assert.equal(r2.runAll, true);
  } finally { if (prev) process.env.VTO_ANALYZER = prev; else delete process.env.VTO_ANALYZER; analyzer._resetAnalyzer(); }
});
