// Regression tests of the collector (WP2 of BLOCKERS-1.0.md).   node --test collector/test/
// Runs the fixture project (fixtures/proj, copied to a temp dir) through run-raw.mjs with the Vitest
// installed for the corpus harness, and checks the raw records.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from '../hash.mjs';
import { canonicalRoot, canonicalFile, isCaseInsensitive, makeRel, toPosix } from '../paths.mjs';
import { instrument, hasIgnorePragma } from '../plugin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLLECTOR = path.join(HERE, '..');
const NM = path.join(COLLECTOR, 'corpus', 'node_modules');
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vto-collector-test-'));
after(() => { if (!process.env.VTO_TEST_KEEP) fs.rmSync(TMP, { recursive: true, force: true }); else console.log('kept', TMP); });

function project(name) {
  const dir = path.join(TMP, name);
  fs.cpSync(path.join(HERE, 'fixtures', 'proj'), dir, { recursive: true });
  fs.symlinkSync(NM, path.join(dir, 'node_modules'), 'junction');
  return dir;
}
function readRaw(rawDir) {
  const recs = [];
  for (const f of fs.readdirSync(rawDir)) if (/^w-.*\.jsonl$/.test(f)) for (const l of fs.readFileSync(path.join(rawDir, f), 'utf8').split('\n')) if (l) recs.push(JSON.parse(l));
  const by = (t) => recs.filter((r) => r.t === t);
  return {
    recs, meta: by('meta')[0], files: new Map(by('file').map((r) => [r.file, r])),
    load: new Map(by('fileload').map((r) => [r.testFile, r])),
    tests: by('test'), test: (file, name) => by('test').find((r) => r.file === file && r.name === name),
  };
}
function collect(name, args = [], { cwd, env = {}, script = path.join(COLLECTOR, 'run-raw.mjs'), dir = project(name) } = {}) {
  const raw = path.join(TMP, 'raw-' + name);
  const argv = script.endsWith('run-raw.mjs') ? [script, raw, ...args] : [script, cwd ?? dir, raw, ...args];
  const r = spawnSync(process.execPath, argv, { cwd: cwd ?? dir, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', CI: '', VTO_RAW_DIR: '', VTO_ROOT: '', VTO_RUN_ID: '', VTO_CASE_INSENSITIVE: '', ...env } });
  return { dir, raw, status: r.status, out: r.stdout + r.stderr, ...readRaw(raw) };
}

let main; // the default (forks) run of the whole fixture, shared by most tests
before(() => { main = collect('main'); });

test('fixture run: Vitest reports the intended failures only', () => {
  assert.equal(main.status, 1, main.out);
  assert.match(main.out, /Tests\s+1 failed \| 34 passed \| 5 skipped \| 1 todo/);
});

// ---- C-B3 ----------------------------------------------------------------------------------------
test('C-B3: modules loaded by await import() in a test (after vi.resetModules) are dependencies', () => {
  assert.deepEqual(main.load.get('test/lazy.test.ts').modules, ['src/config.ts']);
});
test('C-B3: lazily imported module behind a statically imported one (lazy route)', () => {
  assert.deepEqual(main.load.get('test/app.test.ts').modules.sort(), ['src/app.ts', 'src/page.ts']);
});
test('C-B3: imports inside beforeEach / afterAll hooks, lazy JSON, JSON followed by vi.resetModules()', () => {
  const m = main.load.get('test/lazy-json.test.ts').modules;
  for (const f of ['src/static.ts', 'src/hook.ts', 'src/late.ts', 'src/data.json', 'src/reset.json']) assert.ok(m.includes(f), `${f} missing in ${m}`);
  assert.ok(!m.includes('test/lazy-json.test.ts'));
  assert.equal(main.load.get('test/lazy-json.test.ts').modulesComplete, undefined);
});

// ---- C-M1 / S-N2 ---------------------------------------------------------------------------------
test('C-M1: fd, FileHandle, copy, glob, stream, `..` and URL reads are recorded', () => {
  const l = main.load.get('test/reads.test.ts');
  for (const f of ['src/b.txt', 'src/c.txt', 'src/d.txt', 'src/e.txt', 'src/f.txt', 'src/g.txt', 'src/h.txt', 'docs/url.txt', 'src/tree', 'docs']) assert.ok(l.reads.includes(f), `${f} missing in ${l.reads}`);
  assert.ok(!l.reads.some((r) => r.includes('..')), 'unresolved .. segment');
  assert.ok(!l.reads.includes('.'), 'the project root must not be recorded for stat-like calls');
  assert.equal(l.readsComplete, true);
  assert.equal(l.spawnsProcesses, undefined);
});
test('C-M1: graceful-fs, fs-extra and fast-glob go through the wrapped fs', () => {
  const l = main.load.get('test/reads-libs.test.ts');
  for (const f of ['docs/gfs.txt', 'docs/fse.json', 'docs/fg']) assert.ok(l.reads.includes(f), `${f} missing in ${l.reads}`);
  assert.equal(l.readsComplete, true);
});
test('C-M1: child processes and worker threads are flagged, reads marked incomplete', () => {
  for (const f of ['test/spawn.test.ts', 'test/spawn-async.test.ts']) {
    assert.equal(main.load.get(f).spawnsProcesses, true, f);
    assert.equal(main.load.get(f).readsComplete, false, f);
  }
  assert.equal(main.load.get('test/worker.test.ts').usesWorkers, true);
  assert.equal(main.load.get('test/worker.test.ts').readsComplete, false);
  const plain = main.load.get('test/plain.test.ts');
  assert.equal(plain.readsComplete, true);
  assert.equal(plain.spawnsProcesses, undefined);
  assert.equal(plain.usesWorkers, undefined);
});
test('VTO_READS=0 writes no `reads` and no readsComplete (analyzer heuristics apply), flags stay', () => {
  const r = collect('noreads', ['test/reads.test.ts', 'test/spawn.test.ts'], { env: { VTO_READS: '0' } });
  const l = r.load.get('test/reads.test.ts');
  assert.ok(l && !('reads' in l) && !('readsComplete' in l), JSON.stringify(l));
  assert.equal(r.load.get('test/spawn.test.ts').readsComplete, false);
});

// ---- C-M3 / C-M5 ---------------------------------------------------------------------------------
test('C-M5: tests skipped at collection get hit-less skip / todo records', () => {
  const st = (n) => main.test('test/skip.test.ts', n)?.state;
  assert.equal(st('runs'), 'pass');
  assert.equal(st('skipped'), 'skip');
  assert.equal(st('todo later'), 'todo');
  assert.equal(st('ci only'), 'skip');
  assert.equal(st('skipped suite > inner'), 'skip');
  assert.deepEqual(main.test('test/skip.test.ts', 'ci only').hits, {});
  assert.equal(main.test('test/skip.test.ts', 'ci only').line, 6);
  assert.equal(main.load.get('test/skip.test.ts').error, undefined);
});
test('C-M5: a test file whose tests are all skipped: skip record, no fileload, listed in meta.testFiles', () => {
  const recs = main.tests.filter((t) => t.file === 'test/allskip.test.ts');
  assert.equal(recs.length, 1, 'exactly one record (no duplicate from worker + runner)');
  assert.equal(recs[0].state, 'skip');
  assert.equal(main.load.has('test/allskip.test.ts'), false);
  assert.ok(main.meta.testFiles.includes('test/allskip.test.ts'));
});
test('C-M5: a -t filter leaves the other tests as skip records', () => {
  const r = collect('filter', ['test/fail.test.ts', '-t', 'passes']);
  assert.equal(r.tests.find((t) => t.name === 'passes').state, 'pass');
  assert.equal(r.tests.find((t) => t.name === 'fails before reaching label').state, 'skip');
});
test('C-M3: a failing beforeAll marks the fileload record and its tests', () => {
  assert.equal(main.load.get('test/hookfail.test.ts').error, true);
  assert.equal(main.test('test/hookfail.test.ts', 'never runs').state, 'skip');
});
test('C-M3: a test file that fails to load is never recorded as healthy', () => {
  const l = main.load.get('test/importfail.test.ts'); // written only when the worker gets to flush
  if (l) assert.equal(l.error, true);
  assert.equal(main.tests.some((t) => t.file === 'test/importfail.test.ts'), false);
  assert.ok(main.meta.testFiles.includes('test/importfail.test.ts'));
});
test('C-M3: a failed test is recorded as fail (truncated coverage is visible as such)', () => {
  const t = main.test('test/fail.test.ts', 'fails before reaching label');
  assert.equal(t.state, 'fail');
  assert.equal(t.hits['src/label.ts'], undefined);
  assert.equal(main.load.get('test/fail.test.ts').error, undefined);
});
test('meta.testFiles lists every collected test file', () => {
  const onDisk = fs.readdirSync(path.join(main.dir, 'test')).filter((f) => f.endsWith('.test.ts')).map((f) => 'test/' + f).sort();
  assert.deepEqual(main.meta.testFiles, onDisk);
  for (const f of main.load.keys()) assert.ok(main.meta.testFiles.includes(f));
});

// ---- Function.prototype.toString ------------------------------------------------------------------
test('vto-ignore-file: module left untouched, registered with an empty block table', () => {
  assert.equal(main.test('test/tostring.test.ts', 'serialised function still runs (vto-ignore-file)').state, 'pass');
  const f = main.files.get('src/serialized.ts');
  assert.deepEqual(f.blocks, []);
  assert.ok(main.load.get('test/tostring.test.ts').modules.includes('src/serialized.ts'));
  assert.equal(hasIgnorePragma('// vto-ignore-file\nexport const a = 1'), true);
  assert.equal(hasIgnorePragma('/**\n * vto-ignore-file\n */\nexport const a = 1'), true);
  assert.equal(hasIgnorePragma('export const s = "vto-ignore-file"'), false);
  const src = 'export function f(a) { return a ? 1 : 2; }\n';
  assert.ok(instrument(src, '/x/a.ts').blocks.length > 0);
  const ign = instrument('/* vto-ignore-file */\n' + src, '/x/a.ts');
  assert.deepEqual(ign.blocks, []);
  assert.ok(ign.code.includes(src), 'function source must be byte-identical');
});

// ---- A-5 -----------------------------------------------------------------------------------------
test('A-5: one content hash – BOM and CRLF do not change it; file.sha256 uses it; no 16-hex `hash`', () => {
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  assert.equal(contentHash(Buffer.from('a\nb\n')), sha('a\nb\n'));
  assert.equal(contentHash(Buffer.from('\uFEFFa\r\nb\r\n')), sha('a\nb\n'));
  assert.equal(contentHash(Buffer.from('a\rb\r\n')), sha('a\rb\n'), 'a lone CR is kept');
  assert.equal(contentHash(Buffer.from('\uFEFF\uFEFFa')), sha('\uFEFFa'), 'only one BOM is removed');
  assert.equal(contentHash(Buffer.from([0xff, 0x0d, 0x0a, 0x00])), sha(Buffer.from([0xff, 0x0a, 0x00])), 'defined on bytes');
  assert.equal(contentHash(''), sha(''));
  assert.equal(contentHash('\r\n'), sha('\n'));
  const vectors = path.join(COLLECTOR, '..', 'contracts', 'fixtures', 'hash-vectors.json');
  if (fs.existsSync(vectors)) {
    const v = JSON.parse(fs.readFileSync(vectors, 'utf8'));
    assert.ok((v.vectors ?? []).length > 3);
    for (const c of v.vectors) {
      const want = c.contentHash ?? c.hash ?? c.sha256 ?? c.expected;
      const input = c.hex !== undefined ? Buffer.from(c.hex, 'hex') : c.base64 !== undefined ? Buffer.from(c.base64, 'base64') : c.bytes !== undefined ? Buffer.from(c.bytes) : c.utf8 !== undefined ? Buffer.from(c.utf8, 'utf8') : c.text !== undefined ? Buffer.from(c.text, 'utf8') : null;
      assert.ok(input && typeof want === 'string', `unknown vector shape: ${JSON.stringify(c).slice(0, 120)}`);
      assert.equal(contentHash(input), want, JSON.stringify(c).slice(0, 120));
    }
  }
  const rec = main.files.get('src/config.ts');
  assert.equal(rec.sha256, contentHash(fs.readFileSync(path.join(main.dir, 'src/config.ts'))));
  assert.equal('hash' in rec, false);
});
test('A-5: a CRLF + BOM checkout records the same sha256 as the LF checkout', () => {
  const dir = project('crlf');
  const f = path.join(dir, 'src/label.ts');
  const lf = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, '\uFEFF' + lf.replace(/\n/g, '\r\n'));
  const r = collect('crlf', ['test/plain.test.ts'], { dir });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.files.get('src/label.ts').sha256, main.files.get('src/label.ts').sha256);
  assert.deepEqual(r.files.get('src/label.ts').blocks.map((b) => b[0]), main.files.get('src/label.ts').blocks.map((b) => b[0]));
});

// ---- A-1 / U-7 -----------------------------------------------------------------------------------
test('A-1: run-raw started through a symlinked project path records the canonical root', { skip: process.platform === 'win32' }, () => {
  const dir = project('real');
  const link = path.join(TMP, 'link-run');
  fs.symlinkSync(dir, link);
  const r = collect('link-run', ['test/lazy-json.test.ts', 'test/reads.test.ts'], { dir, cwd: link, env: { PWD: link } });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.meta.root, toPosix(dir));
  assert.ok(r.load.get('test/lazy-json.test.ts').modules.includes('src/data.json'));
  assert.ok(r.load.get('test/reads.test.ts').reads.includes('src/b.txt'));
});
test('A-1: embedding tool passes a symlinked VTO_ROOT – the worker canonicalises it', { skip: process.platform === 'win32' }, () => {
  const dir = project('real2');
  const link = path.join(TMP, 'link-lane');
  fs.symlinkSync(dir, link);
  const r = collect('link-lane', ['test/lazy-json.test.ts', 'test/reads.test.ts', 'test/plain.test.ts'], { dir, cwd: link, script: path.join(HERE, 'lane-like.mjs') });
  const l = r.load.get('test/lazy-json.test.ts');
  assert.ok(l, r.out);
  for (const f of ['src/static.ts', 'src/data.json', 'src/reset.json', 'src/late.ts']) assert.ok(l.modules.includes(f), `${f} missing in ${l.modules}`); // non-instrumented modules used to vanish
  assert.ok(r.load.get('test/reads.test.ts').reads.includes('src/b.txt'));
  assert.equal(r.test('test/plain.test.ts', 'label').hits['src/label.ts'].length > 0, true);
  // vto's own setup file must not be instrumented / recorded as a project source
  assert.deepEqual([...r.files.keys()].filter((f) => f.includes('setup-v2') || path.isAbsolute(f)), []);
  for (const fl of r.load.values()) assert.deepEqual(fl.modules.filter((m) => m.includes('setup-v2') || path.isAbsolute(m)), []);
});
test('A-1 / U-7: main-process path helpers', () => {
  const dir = path.join(TMP, 'canon'); fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.writeFileSync(path.join(dir, 'src', 'a.ts'), '');
  assert.equal(toPosix('c:\\Proj\\src\\'), 'C:/Proj/src');
  assert.equal(toPosix('\\\\?\\C:\\Proj'), 'C:/Proj');
  assert.equal(toPosix('\\\\?\\UNC\\srv\\share\\p'), '//srv/share/p');
  assert.equal(toPosix('/p/c\u030cen\u00edk.ts'), '/p/\u010den\u00edk.ts');
  if (process.platform !== 'win32') {
    const link = path.join(TMP, 'canon-link'); fs.symlinkSync(dir, link);
    assert.equal(canonicalRoot(link), toPosix(dir));
    assert.equal(canonicalFile(path.join(link, 'src', 'a.ts')), toPosix(path.join(dir, 'src', 'a.ts')));
    assert.equal(canonicalFile(path.join(link, 'src', 'new', 'b.ts')), toPosix(path.join(dir, 'src', 'new', 'b.ts')), 'not-yet-existing file: nearest existing parent');
  }
  const ci = isCaseInsensitive(dir);
  assert.equal(ci, fs.existsSync(path.join(dir, 'SRC', 'A.TS')));
  assert.equal(makeRel('C:/Proj', true)('c:\\proj\\src\\a.ts'), 'src/a.ts');
  assert.equal(makeRel('/p', false)('/P/src/a.ts'), '/P/src/a.ts');
  assert.equal(main.meta.caseInsensitive, isCaseInsensitive(main.dir));
});
test('U-7: Windows / case-insensitive / NFC path rules of the worker (run inside the fixture)', () => {
  const unit = main.tests.filter((t) => t.file === 'test/paths-unit.test.ts');
  assert.ok(unit.length >= 13);
  assert.deepEqual(unit.filter((t) => t.state !== 'pass').map((t) => t.name), []);
});

// ---- other pools ---------------------------------------------------------------------------------
for (const pool of ['vmThreads', 'threads']) {
  test(`pool ${pool}: late modules, reads and process flags`, () => {
    const r = collect('pool-' + pool, ['--pool=' + pool, 'test/lazy.test.ts', 'test/lazy-json.test.ts', 'test/reads.test.ts', 'test/reads-libs.test.ts', 'test/spawn.test.ts', 'test/worker.test.ts', 'test/skip.test.ts', 'test/plain.test.ts']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.load.get('test/lazy.test.ts').modules, ['src/config.ts']);
    for (const f of ['src/late.ts', 'src/data.json', 'src/reset.json']) assert.ok(r.load.get('test/lazy-json.test.ts').modules.includes(f), f);
    for (const f of ['src/b.txt', 'src/c.txt', 'src/d.txt', 'src/g.txt', 'src/h.txt', 'docs/url.txt']) assert.ok(r.load.get('test/reads.test.ts').reads.includes(f), f);
    assert.ok(r.load.get('test/reads-libs.test.ts').reads.includes('docs/gfs.txt'));
    assert.equal(r.load.get('test/reads.test.ts').readsComplete, true);
    assert.equal(r.load.get('test/spawn.test.ts').spawnsProcesses, true);
    assert.equal(r.load.get('test/worker.test.ts').usesWorkers, true);
    assert.equal(r.load.get('test/plain.test.ts').spawnsProcesses, undefined);
    assert.equal(r.load.get('test/plain.test.ts').usesWorkers, undefined);
    assert.equal(r.test('test/skip.test.ts', 'ci only').state, 'skip');
  });
}

// ---- meta.dirtyFiles, entrypoint ------------------------------------------------------------------
test('meta: gitHead, dirty and dirtyFiles (tracked change, untracked file, non-ASCII name)', () => {
  const dir = project('git');
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { stdio: 'pipe' }).toString().trim();
  try { git('init', '-q'); } catch { return; } // no git: nothing to check
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n.vto-tmp\n');
  git('add', '-A'); git('commit', '-q', '-m', 'init');
  const clean = collect('git-clean', ['test/plain.test.ts'], { dir });
  assert.equal(clean.meta.gitHead, git('rev-parse', 'HEAD'));
  assert.equal(clean.meta.dirty, false);
  assert.equal('dirtyFiles' in clean.meta, false);
  assert.equal(clean.meta.formatVersion, '2.2');
  fs.appendFileSync(path.join(dir, 'src/label.ts'), '// edit\n');
  fs.writeFileSync(path.join(dir, 'src/\u010den\u00edk nov\u00fd.ts'), 'export const c = 1;\n');
  fs.rmSync(path.join(dir, 'src/late.ts'));
  const dirty2 = collect('git-dirty', ['test/plain.test.ts'], { dir });
  assert.deepEqual(dirty2.meta.dirtyFiles, [
    { path: 'src/label.ts', sha256: contentHash(fs.readFileSync(path.join(dir, 'src/label.ts'))) },
    { path: 'src/late.ts', sha256: null },
    { path: 'src/\u010den\u00edk nov\u00fd.ts', sha256: contentHash('export const c = 1;\n') },
  ]);
});
test('vitest-overlap.mjs starts (--help)', () => {
  const r = spawnSync(process.execPath, [path.join(COLLECTOR, '..', 'vitest-overlap.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--raw DIR/);
});

// ---- contract ------------------------------------------------------------------------------------
test('records carry only fields known to contracts/raw-2.schema.json (plus the additions requested from WP1)', () => {
  const file = path.join(COLLECTOR, '..', 'contracts', 'raw-2.schema.json');
  if (!fs.existsSync(file)) return;
  const defs = JSON.parse(fs.readFileSync(file, 'utf8')).$defs;
  const pending = { fileload: ['spawnsProcesses', 'usesWorkers', 'modulesComplete'] }; // requested, see setup-v2.mjs finishFile
  const states = new Set(defs.test.properties.state.enum);
  for (const r of main.recs) {
    const d = defs[r.t];
    assert.ok(d, `unknown record kind ${r.t}`);
    for (const k of d.required ?? []) assert.ok(k in r, `${r.t}: required field ${k} missing`);
    const known = new Set([...Object.keys(d.properties), ...(pending[r.t] ?? [])]);
    for (const k of Object.keys(r)) assert.ok(known.has(k), `${r.t}.${k} is not in the schema`);
    if (r.t === 'test') assert.ok(states.has(r.state), r.state);
    if (r.t === 'file') assert.match(r.sha256, /^[0-9a-f]{64}$/);
  }
});
