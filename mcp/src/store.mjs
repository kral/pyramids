// Coverage map kept by the daemon (in memory + .vto/ on disk), patched after every run.
//
// Paths (contracts/DECISIONS.md D2, REVIEW-2-architecture A-9): everything ON DISK is keyed by
// root-relative, NFC, `/` paths (files outside the root: absolute), so .vto/ can move between
// checkouts and CI work directories. In memory the store keeps absolute paths under the canonical
// (realpath) root of THIS process; they are converted on load/save only.
// Content versions are contentHash (D1: SHA-256, BOM/CRLF-insensitive).
//
// On disk (.vto/):
//   state.json          versions (content sha) of every tracked file at record time, dirty sets,
//                       failing tests, stale reasons, trigger hashes, last full run
//   blobs/<sha>         content of each recorded version (old side of every diff; no git needed)
//   map/s-files.jsonl   one {"t":"file"} block table per source file (current recorded version)
//   map/s-meta.jsonl    {"t":"meta", version, root, pathBase:"root", gitHead, setupFiles, producer}
//   tree.json           project file list at the last complete full run (new-file detection)
//   map/t/s-<h>.jsonl   per test file: its {"t":"fileload"}, {"t":"env"} and {"t":"test"} records
//   (the analyzer reads only w-*.jsonl / s-*.jsonl; older maps without the s- prefix are migrated on load)
// map/ is a valid FORMAT.md v2 raw dir, so the Rust analyzer reads it directly.
//
// Patching rules (see README "Map maintenance"):
//   - a test that ran replaces its record (key = relFile:line > name); a fully run test file
//     replaces all its records (deleted tests disappear); partial runs union the fileload data
//   - when a source file's recorded version advances (new block table from this run), records of
//     tests that did NOT run are remapped block-by-block through the line diff old→new; a block
//     that cannot be mapped marks the test dirty (always selected until it re-runs)
//   - a file without blocks (json, css, barrels) advances only when every test file that loads it
//     re-ran; otherwise it stays "changed" and keeps selecting its loaders
//   - test files that failed to load keep their old records and version (stay selected)
//   - fileload records keep every field the collector wrote (reads, readsComplete, error, …);
//     partial runs union them (C-M4)
//   - dirty marks are only removed by a run that covers them: a complete re-run of the test (file).
//     Cancelled / timed-out / bailed runs never replace a test file as a whole, and marks set
//     because a file changed DURING the run survive that run
import fs from 'node:fs';
import path from 'node:path';
import { sha1, slash, normText } from './platform.mjs';
import { diffLines, lineMapper } from './diff.mjs';
import { relKey, absKey, isCaseInsensitive, canonicalRoot } from './paths.mjs';
import { StateDir, writePrivate, readPrivate } from './safefs.mjs';
import { outId } from './redact.mjs';

// 2: root-relative keys, contentHash (sha256) versions. Older state cannot be compared → discarded loudly.
export const STATE_VERSION = 2;

export class MapStore {
  constructor(root, dir, { stateDir } = {}) {
    this.root = canonicalRoot(root);
    this.dir = dir || path.join(this.root, '.vto');
    // every write below .vto/ goes through the StateDir (no symlink is ever followed, 0700/0600)
    this.sd = stateDir || new StateDir(path.dirname(path.resolve(this.dir)), path.basename(this.dir));
    this.mapDir = path.join(this.dir, 'map');
    this.blobDir = path.join(this.dir, 'blobs');
    /** rel keys of every project file at the last complete full run (null = never recorded) */
    this.known = null;
    this.knownDirty = false;
    /** reasons collected while loading (discarded / damaged map) → stale reasons of the engine */
    this.loadNotes = [];
    this.state = emptyState();
    /** abs file → block table JSON string */
    this.blocks = new Map();
    /** abs test file → { fileload, tests: Map<key, rec> } */
    this.tests = new Map();
    this.dirtyShards = new Set();
    this.filesDirty = false;
    this.generation = 0; // bumps on every change (report cache key)
  }

  // ---------------------------------------------------------------- persistence
  load() {
    let raw;
    try { raw = JSON.parse(readPrivate(path.join(this.dir, 'state.json')).toString('utf8')); } catch { return false; }
    if (!raw || raw.version !== STATE_VERSION) {
      // never silently: the next selection says why it runs everything (REVIEW-2-architecture §2.1)
      this.loadNotes.push(`coverage map of another vto state version (${raw?.version ?? '?'} → ${STATE_VERSION}) was discarded: recording it again`);
      this.discardDisk();
      return false;
    }
    this.state = this.stateFromDisk({ ...emptyState(), ...raw });
    let bad = 0;
    const parse = (l) => { try { return absRecord(this.root, JSON.parse(l)); } catch { bad++; return null; } };
    const text = readPrivate(path.join(this.mapDir, 's-files.jsonl'))?.toString('utf8') ?? '';
    for (const l of text.split('\n')) { if (!l) continue; const r = parse(l); if (r?.t === 'file' && r.file) this.blocks.set(r.file, JSON.stringify(r.blocks)); }
    let shards = [];
    try { if (this.sd.exists(...this.sub('map', 't'))) shards = fs.readdirSync(path.join(this.mapDir, 't')); } catch {}
    for (const s of shards) {
      if (!s.endsWith('.jsonl') || !s.startsWith('s-')) continue;
      const body = readPrivate(path.join(this.mapDir, 't', s))?.toString('utf8') ?? '';
      for (const l of body.split('\n')) {
        if (!l) continue;
        const r = parse(l);
        if (!r) continue;
        const tf = r.t === 'test' ? r.file : r.testFile;
        if (!tf) continue;
        const e = this.entry(tf);
        if (r.t === 'fileload') e.fileload = r; else if (r.t === 'test') e.tests.set(this.key(r), r); else if (r.t === 'env') e.env = r;
      }
    }
    // one damaged line must not stop the engine, and must not silently shrink the map either
    if (bad) this.addStale(`coverage map damaged (${bad} unreadable line${bad > 1 ? 's' : ''} in .vto/map)`);
    // D2.5: a map whose test files do not exist below this root is never answered with "0 selected"
    if (this.tests.size && ![...this.tests.keys()].some((tf) => fs.existsSync(tf))) this.addStale(`coverage map does not belong to this root (${this.root}): none of its test files exist here`);
    try { const t = JSON.parse(readPrivate(path.join(this.dir, 'tree.json')).toString('utf8')); if (t?.version === 1 && Array.isArray(t.files)) this.known = new Set(t.files); } catch {}
    return this.tests.size > 0;
  }
  addStale(reason) { if (!this.state.stale.includes(reason)) this.state.stale.push(reason); }
  sub(...parts) { return path.relative(this.sd.root, path.join(this.dir, ...parts)).split(path.sep).filter(Boolean); }
  discardDisk() {
    for (const n of ['map', 'blobs']) { try { if (this.sd.exists(...this.sub(n))) fs.rmSync(path.join(this.dir, n), { recursive: true, force: true }); } catch {} }
    for (const n of ['state.json', 'tree.json']) fs.rmSync(path.join(this.dir, n), { force: true });
    this.sd.ok.clear();
  }

  /** state.json form: every path key root-relative (portable between checkouts) */
  stateToDisk() {
    const R = (f) => relKey(this.root, f);
    const K = (o) => { const out = {}; for (const k in o || {}) out[R(k)] = o[k]; return out; };
    const st = this.state;
    return { ...st, files: K(st.files), triggers: K(st.triggers), dirtyFiles: K(st.dirtyFiles), setupFiles: (st.setupFiles || []).map(R),
      ...(st.testFiles ? { testFiles: st.testFiles.map(R) } : {}), ...(st.testDirs ? { testDirs: K(st.testDirs) } : {}), pathBase: 'root' };
  }
  stateFromDisk(st) {
    const A = (k) => absKey(this.root, k);
    const K = (o) => { const out = {}; for (const k in o || {}) out[A(k)] = o[k]; return out; };
    return { ...st, files: K(st.files), triggers: K(st.triggers), dirtyFiles: K(st.dirtyFiles), setupFiles: (st.setupFiles || []).map(A),
      ...(st.testFiles ? { testFiles: st.testFiles.map(A) } : {}), ...(st.testDirs ? { testDirs: K(st.testDirs) } : {}) };
  }

  save() {
    const tDir = this.sd.dir(...this.sub('map', 't'));
    if (this.filesDirty) {
      let s = '';
      for (const [f, b] of this.blocks) s += `{"t":"file","file":${JSON.stringify(relKey(this.root, f))},"blocks":${b}}\n`;
      // file names: the analyzer reads only w-*.jsonl / s-*.jsonl ("s" = stored map)
      writePrivate(path.join(this.mapDir, 's-files.jsonl'), s);
      writePrivate(path.join(this.mapDir, 's-meta.jsonl'), JSON.stringify({ t: 'meta', version: 2, root: this.root, pathBase: 'root', gitHead: this.state.gitHead, setupFiles: (this.state.setupFiles || []).map((f) => relKey(this.root, f)), producer: 'vto-daemon' }) + '\n');
      this.filesDirty = false;
    }
    for (const tf of this.dirtyShards) {
      const p = path.join(tDir, shardName(this.relOf(tf)));
      const e = this.tests.get(tf);
      if (!e || (!e.fileload && !e.tests.size)) { fs.rmSync(p, { force: true }); continue; }
      let s = e.fileload ? JSON.stringify(relRecord(this.root, e.fileload)) + '\n' : '';
      if (e.env) s += JSON.stringify(relRecord(this.root, e.env)) + '\n';
      for (const r of e.tests.values()) s += JSON.stringify(relRecord(this.root, r)) + '\n';
      writePrivate(p, s);
    }
    this.dirtyShards.clear();
    if (this.knownDirty && this.known) { writePrivate(path.join(this.sd.dir(...this.sub()), 'tree.json'), JSON.stringify({ version: 1, files: [...this.known].sort() })); this.knownDirty = false; }
    this.state.updatedAt = new Date().toISOString();
    writePrivate(path.join(this.sd.dir(...this.sub()), 'state.json'), JSON.stringify(this.stateToDisk()));
  }
  setKnown(files) { this.known = new Set(files); this.knownDirty = true; }

  clear() {
    if (this.sd.exists(...this.sub('map'))) fs.rmSync(this.mapDir, { recursive: true, force: true });
    this.blocks.clear(); this.tests.clear(); this.state = { ...emptyState(), triggers: this.state.triggers };
    this.generation++;
  }

  // ---------------------------------------------------------------- helpers
  relOf(abs) { return relKey(this.root, abs); }
  /** stored key / client path → the store's absolute key (D2: NFC; case folded on a case-insensitive root) */
  absOf(r) { return this.canon(absKey(this.root, r)); }
  get caseInsensitive() { return (this._ci ??= isCaseInsensitive(this.root)); }
  canon(abs) {
    if (this.tests.has(abs) || this.blocks.has(abs) || this.state.files[abs]) return abs;
    if (!this.caseInsensitive && !/^[A-Za-z]:\//.test(abs)) return abs;
    const low = abs.toLowerCase();
    for (const k of this.tests.keys()) if (k.toLowerCase() === low) return k;
    for (const k of this.blocks.keys()) if (k.toLowerCase() === low) return k;
    for (const k in this.state.files) if (k.toLowerCase() === low) return k;
    return abs;
  }
  key(r) { return `${this.relOf(r.file)}:${r.line ?? 0} > ${r.name}`; }
  /** record of test file `tf` whose id, in the escaped form that leaves the engine (redact.outId), is `id` */
  findByOutId(tf, id) {
    const e = this.tests.get(tf);
    if (!e) return null;
    for (const [k, r] of e.tests) if (outId(k) === id) return r;
    return null;
  }
  entry(tf) { let e = this.tests.get(tf); if (!e) { e = { fileload: null, env: null, tests: new Map() }; this.tests.set(tf, e); } return e; }
  hasMap() { return this.tests.size > 0; }
  testCount() { let n = 0; for (const e of this.tests.values()) n += e.tests.size; return n; }

  saveBlob(sha, text) {
    if (!/^[0-9a-f]{8,64}$/.test(sha)) return;
    const p = path.join(this.sd.dir(...this.sub('blobs', sha.slice(0, 2))), sha);
    if (!fs.existsSync(p)) writePrivate(p, text);
  }
  readBlob(sha) {
    if (!/^[0-9a-f]{8,64}$/.test(String(sha))) return null;
    return readPrivate(path.join(this.blobDir, sha.slice(0, 2), sha))?.toString('utf8') ?? null;
  }

  /** every file the map depends on (abs): block files, loaded modules, test files, files read through fs */
  trackedFiles() {
    const s = new Set(this.blocks.keys());
    for (const [tf, e] of this.tests) {
      s.add(tf);
      if (!e.fileload) continue;
      for (const m of e.fileload.modules || []) s.add(typeof m === 'string' ? m : m.file);
      for (const r of e.fileload.reads || []) if (this.trackableRead(r)) s.add(r);
    }
    return s;
  }
  /** fs reads worth watching: inside the project, not dependencies / vto's own state */
  trackableRead(r) { return r.startsWith(this.root + '/') && !/\/(node_modules|\.vto|\.git)(\/|$)/.test(r.slice(this.root.length)); }

  /**
   * test files (abs) that load f (D5.6): fileload.modules contains it, a test or the file load hit it,
   * or the test file read it through fs (the file itself or a directory at / above it)
   */
  loadersOf(f) {
    const out = [];
    for (const [tf, e] of this.tests) {
      const fl = e.fileload;
      if (tf === f || fl?.modules?.some((m) => (typeof m === 'string' ? m : m.file) === f) || fl?.hits?.[f] || fl?.reads?.some((r) => r === f || f.startsWith(r + '/'))) { out.push(tf); continue; }
      for (const r of e.tests.values()) if (r.hits?.[f]) { out.push(tf); break; }
    }
    return out;
  }
  /** test files (abs) with a recorded fs read of directory `dir` or one above it (D5.4: new file in a read directory) */
  dirReaders(dir) {
    const out = [];
    for (const [tf, e] of this.tests) if (e.fileload?.reads?.some((r) => r === dir || dir.startsWith(r + '/'))) out.push(tf);
    return out;
  }

  // ---------------------------------------------------------------- ingest
  /**
   * Patch the map with the raw records of one run.
   * @param {string} rawDir      directory the collector wrote into during this run
   * @param {object} run
   *   ran: Map<absTestFile, {full:boolean}>   test files that were scheduled
   *   snapshot: Map<abs, {sha, text?}>       content of tracked/changed files at run start
   *   loadFailed: Set<absTestFile>           files that failed to import/collect
   *   readFile(abs) → {sha,text}             fallback for files not in snapshot
   */
  ingest(rawDirs, run) {
    const recs = [].concat(rawDirs).flatMap((d) => readRaw(d)).map((r) => absRecord(this.root, r)).sort((a, b) => (a.t === 'file' ? 0 : 1) - (b.t === 'file' ? 0 : 1));
    const newBlocks = new Map();
    const fileloads = new Map();
    const testsByFile = new Map();
    const envs = new Map();
    for (const r of recs) {
      if (r.t === 'env' && r.testFile) { const tf = slash(r.testFile); const p = envs.get(tf); envs.set(tf, { t: 'env', testFile: tf, env: r.env, dom: !!(p?.dom || r.dom) }); continue; }
      if (r.t === 'file') newBlocks.set(slash(r.file), JSON.stringify(r.blocks));
      else if (r.t === 'fileload' && r.testFile) {
        const tf = slash(r.testFile);
        const prev = fileloads.get(tf);
        fileloads.set(tf, prev ? unionFileload(prev, r) : normFileload(r));
      } else if (r.t === 'test' && r.file) {
        r.file = slash(r.file);
        r.hits = normHits(r.hits);
        let m = testsByFile.get(r.file); if (!m) testsByFile.set(r.file, (m = new Map()));
        // same key twice in one run = test.each rows with identical names on one line (retries are
        // reported once by the collector): keep the union, so no row's coverage is lost
        const k = this.key(r), prev = m.get(k);
        if (prev) {
          for (const f in r.hits) prev.hits[f] = [...new Set([...(prev.hits[f] || []), ...r.hits[f]])].sort((x, y) => x - y);
          if (r.state === 'fail') prev.state = 'fail';
          prev.dup = (prev.dup || 1) + 1;
        } else m.set(k, r);
      }
    }
    const stats = { tests: 0, testFiles: 0, remapped: 0, dirtied: 0, advanced: [], recorded: 0 };
    this.ingestStats = stats;
    const content = (f) => run.snapshot.get(f) ?? run.readFile(f);
    // which test files are (fully) replaced in this run
    // an incomplete run (cancelled, timed out, bail) never replaces a test file as a whole: tests that
    // did not get to run would vanish from the map together with their dirty marks
    const replaced = new Map(); // tf → 'full' | 'partial'
    for (const [tf, info] of run.ran) {
      if (run.loadFailed.has(tf) || (!fileloads.has(tf) && !testsByFile.has(tf))) continue;
      replaced.set(tf, info.full && !run.incomplete ? 'full' : 'partial');
    }
    // marks that this very run cannot have covered (file edited while it ran): re-applied after step 2
    const sticky = { tests: new Set(), files: new Set() };
    const ranKeys = new Set();
    for (const m of testsByFile.values()) for (const k of m.keys()) ranKeys.add(k);

    // 1. source files whose block table changed → remap records that do not get replaced
    const unstable = run.unstable || new Set();
    for (const [f, table] of newBlocks) {
      const old = this.blocks.get(f);
      const rec = this.state.files[f];
      const cur = content(f);
      if (unstable.has(f)) {
        // edited during the run: workers may have executed either version → keep the recorded version,
        // mark every test of this run that touched f dirty (selected again next time)
        for (const [, m] of testsByFile) for (const [k, r] of m) if (r.hits?.[f]) { this.state.dirtyTests[k] = 1; sticky.tests.add(k); stats.dirtied++; }
        for (const [tf, fl] of fileloads) if (fl.modules.includes(f) || fl.hits?.[f] || fl.reads?.includes(f)) { this.state.dirtyFiles[tf] = 1; sticky.files.add(tf); stats.dirtied++; }
        if (old === undefined) this.setBlocks(f, table);
        continue;
      }
      if (old === undefined || !rec) { this.setBlocks(f, table); continue; }
      if (rec.sha === cur?.sha && old === table) continue;
      const oldText = this.readBlob(rec.sha);
      const oldTable = JSON.parse(old);
      const hunks = oldText != null && cur?.text != null ? diffLines(normText(oldText), normText(cur.text)) : null;
      const remap = hunks ? makeRemap(oldTable, JSON.parse(table), hunks) : null;
      for (const [tf, e] of this.tests) {
        const mode = replaced.get(tf);
        if (mode === 'full') continue;
        // file-level change (outside every block / in import-time code): every loader is affected
        const loads = e.fileload?.modules?.includes(f) || e.fileload?.hits?.[f] || e.fileload?.reads?.includes(f) || [...e.tests.values()].some((r) => r.hits?.[f]);
        if (loads && (!hunks || fileLevelChange(oldTable, hunks, e.fileload?.hits?.[f] || []))) {
          this.state.dirtyFiles[tf] = 1; stats.dirtied++;
        }
        for (const [k, r] of e.tests) {
          if (mode === 'partial' && ranKeys.has(k)) continue;
          const ids = r.hits?.[f];
          if (!ids) continue;
          const { ids: mapped, ok } = remap ? remap(ids) : { ids: [], ok: false };
          r.hits[f] = mapped;
          if (!mapped.length) delete r.hits[f];
          if (ok) stats.remapped++; else { this.state.dirtyTests[k] = 1; stats.dirtied++; }
          this.dirtyShards.add(tf);
        }
        const fl = e.fileload;
        if (fl?.hits?.[f]) {
          const { ids: mapped, ok } = remap ? remap(fl.hits[f]) : { ids: [], ok: false };
          fl.hits[f] = mapped;
          if (!ok) { this.state.dirtyFiles[tf] = 1; stats.dirtied++; }
          this.dirtyShards.add(tf);
        }
      }
      this.setBlocks(f, table);
      this.advance(f, cur); stats.advanced.push(this.relOf(f));
    }

    // 2. replace records of tests that ran
    for (const [tf, mode] of replaced) {
      const e = this.entry(tf);
      const newTests = testsByFile.get(tf) ?? new Map();
      const fl = fileloads.get(tf);
      if (mode === 'full') {
        e.tests = newTests;
        if (fl) e.fileload = fl;
        if (envs.has(tf)) e.env = envs.get(tf);
        delete this.state.dirtyFiles[tf];
        for (const k of Object.keys(this.state.dirtyTests)) if (k.startsWith(this.relOf(tf) + ':')) delete this.state.dirtyTests[k];
        stats.testFiles++;
      } else {
        for (const [k, r] of newTests) { e.tests.set(k, r); delete this.state.dirtyTests[k]; }
        if (fl) e.fileload = e.fileload ? unionFileload(e.fileload, fl) : fl;
      }
      stats.tests += newTests.size;
      this.dirtyShards.add(tf);
      // test file version: only a full, successful load records the file as it is now
      if (mode === 'full' && fl && !unstable.has(tf)) { const c = content(tf); if (c) this.advance(tf, c); }
    }

    // marks set because a file changed during this run are not covered by this run (C-M4)
    for (const k of sticky.tests) this.state.dirtyTests[k] = 1;
    for (const tf of sticky.files) this.state.dirtyFiles[tf] = 1;

    // 3. newly referenced files become tracked; block-less modules advance when all loaders re-ran
    const tracked = this.trackedFiles();
    for (const f of tracked) {
      if (this.tests.has(f) && !this.state.files[f]) { const c = content(f); if (c) this.advance(f, c); continue; }
      if (this.tests.has(f)) continue;
      const rec = this.state.files[f];
      const cur = content(f);
      if (!cur) continue;
      if (unstable.has(f)) continue;
      if (!rec) { this.advance(f, cur); continue; }
      if (rec.sha === cur.sha) continue;
      if (newBlocks.has(f) || this.blocks.has(f)) continue; // instrumented: handled in 1. (not loaded in this run → stays changed)
      // not instrumented (json, css, svg, ?raw, files read through fs): any change is file-level for its loaders
      const loaders = this.loadersOf(f);
      if (!loaders.some((tf) => replaced.get(tf) === 'full')) continue;
      for (const tf of loaders) if (replaced.get(tf) !== 'full') { this.state.dirtyFiles[tf] = 1; stats.dirtied++; }
      this.advance(f, cur); stats.advanced.push(this.relOf(f));
    }
    this.gc(tracked);
    this.ingestStats = null;
    if (stats.tests || stats.recorded || stats.dirtied) this.generation++;
    return stats;
  }

  setBlocks(f, table) { if (this.blocks.get(f) !== table) { this.blocks.set(f, table); this.filesDirty = true; } }

  advance(f, c) {
    if (!c || c.sha == null) return false;
    const prev = this.state.files[f];
    if (prev?.sha === c.sha) return false;
    if (c.text != null) this.saveBlob(c.sha, c.text);
    this.state.files[f] = { sha: c.sha, prevSha: prev?.sha ?? null, at: Date.now() };
    if (this.ingestStats) this.ingestStats.recorded++;
    return true;
  }

  /** Drop deleted test files and untracked file versions. */
  removeTestFile(tf) {
    if (!this.tests.delete(tf)) return;
    this.dirtyShards.add(tf);
    delete this.state.files[tf];
    delete this.state.dirtyFiles[tf];
    const p = this.relOf(tf) + ':';
    for (const k of Object.keys(this.state.dirtyTests)) if (k.startsWith(p)) delete this.state.dirtyTests[k];
    for (const k of Object.keys(this.state.failing)) if (k.startsWith(p)) delete this.state.failing[k];
    this.generation++;
  }

  gc(tracked = this.trackedFiles()) {
    for (const f of Object.keys(this.state.files)) if (!tracked.has(f)) delete this.state.files[f];
    for (const f of [...this.blocks.keys()]) {
      if (tracked.has(f)) continue;
      let used = false;
      for (const e of this.tests.values()) { for (const r of e.tests.values()) if (r.hits?.[f]) { used = true; break; } if (used) break; }
      if (!used) { this.blocks.delete(f); this.filesDirty = true; }
    }
  }
}

function emptyState() {
  return { version: STATE_VERSION, createdAt: new Date().toISOString(), updatedAt: null, gitHead: null, setupFiles: [],
    files: {}, triggers: {}, dirtyTests: {}, dirtyFiles: {}, failing: {}, stale: [], fullRunAt: null, lastRun: null };
}

function shardName(relTestFile) { return 's-' + sha1(relTestFile).slice(0, 16) + '.jsonl'; }

/** raw records (format 2.1: root-relative paths; 2.0: absolute) → the store's absolute, NFC, `/` keys */
export function absPath(root, p) { return absKey(root, p); }
export function absRecord(root, r) {
  const A = (p) => absKey(root, p);
  const H = (h) => { const o = {}; for (const k in h || {}) o[A(k)] = h[k]; return o; };
  if (r.t === 'file') r.file = A(r.file);
  else if (r.t === 'test') { r.file = A(r.file); r.hits = H(r.hits); }
  else if (r.t === 'fileload') {
    r.testFile = A(r.testFile); r.hits = H(r.hits); r.loadMs = H(r.loadMs);
    const own = `${root}/.vto/`;
    r.modules = (r.modules || []).map((m) => (typeof m === 'string' ? A(m) : { ...m, file: A(m.file) })).filter((m) => !(typeof m === 'string' ? m : m.file).startsWith(own));
    if (Array.isArray(r.reads)) r.reads = r.reads.filter((x) => typeof x === 'string').map(A).filter((x) => !x.startsWith(own));
  }
  else if (r.t === 'env') r.testFile = A(r.testFile);
  return r;
}
/** the stored (on-disk) form of a record: root-relative keys; unknown fields are kept as they are */
export function relRecord(root, r) {
  const R = (p) => (typeof p === 'string' ? relKey(root, p) : p);
  const H = (h) => { const o = {}; for (const k in h || {}) o[R(k)] = h[k]; return o; };
  if (r.t === 'test') return { ...r, file: R(r.file), hits: H(r.hits) };
  if (r.t === 'fileload') return { ...r, testFile: R(r.testFile), hits: H(r.hits), loadMs: H(r.loadMs), modules: (r.modules || []).map((m) => (typeof m === 'string' ? R(m) : { ...m, file: R(m.file) })), ...(r.reads ? { reads: r.reads.map(R) } : {}) };
  if (r.t === 'env') return { ...r, testFile: R(r.testFile) };
  if (r.t === 'file') return { ...r, file: R(r.file) };
  return r;
}

export function readRaw(dir) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { return out; }
  for (const n of names) {
    for (const l of fs.readFileSync(path.join(dir, n), 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { out.push(JSON.parse(l)); } catch {}
    }
  }
  // file records first (a worker writes them before the records that use them, but files are read in any order)
  return out.sort((a, b) => (a.t === 'file' ? 0 : 1) - (b.t === 'file' ? 0 : 1));
}

function normHits(h) { const o = {}; for (const k in h || {}) o[slash(k)] = h[k]; return o; }
function modPath(m) { return slash(typeof m === 'string' ? m : m.file); }
/** Normalised fileload record. EVERY field of the collector is kept (reads, readsComplete, error, future ones – C-M4). */
export function normFileload(r) {
  const loadMs = { ...(r.loadMs || {}) };
  for (const m of r.modules || []) if (typeof m === 'object' && m.loadMs != null) loadMs[modPath(m)] = m.loadMs;
  const out = { ...r, t: 'fileload', testFile: slash(r.testFile), hits: normHits(r.hits), modules: [...new Set((r.modules || []).map(modPath))], loadMs };
  if (Array.isArray(r.reads)) out.reads = [...new Set(r.reads.map(slash))].sort();
  return out;
}
/**
 * Union of two fileload records of the same test file (partial runs, several workers). Sets are
 * united; flags combine towards "less trusted": readsComplete is true only when both say true,
 * `error` when either says so; a missing `reads` on one side stays "unknown" (no reads field).
 */
export function unionFileload(a, b) {
  a = normFileload(a); b = normFileload(b);
  const hits = { ...a.hits };
  for (const f in b.hits) hits[f] = [...new Set([...(hits[f] || []), ...b.hits[f]])].sort((x, y) => x - y);
  const out = { ...a, ...b, t: 'fileload', testFile: a.testFile, hits, modules: [...new Set([...a.modules, ...b.modules])], loadMs: { ...a.loadMs, ...b.loadMs } };
  delete out.reads; delete out.readsComplete; delete out.error;
  if (a.reads && b.reads) out.reads = [...new Set([...a.reads, ...b.reads])].sort();
  if ('readsComplete' in a || 'readsComplete' in b) { if (a.readsComplete === true && b.readsComplete === true) out.readsComplete = true; else if (a.readsComplete === false || b.readsComplete === false) out.readsComplete = false; }
  if (a.error || b.error) out.error = true;
  return out;
}

/**
 * Does the diff touch code outside every block, or a block that ran at import time (`importIds`)?
 * Mirrors the analyzer's "select every loader" rule (FORMAT.md v2 addendum A).
 */
export function fileLevelChange(oldBlocks, hunks, importIds = []) {
  const imp = new Set(importIds);
  // D5.5: a changed line is block-local only when a block STRICTLY contains it (starts on an earlier
  // line and ends on a later one); on a block's first/last line module top-level code can share the
  // line (`export const cols = [{ render: (x) => x }]`) → every loader
  const inBlock = (line) => oldBlocks.some((b) => b[0] < line && line < b[2]);
  const importHit = (line) => oldBlocks.some((b, i) => imp.has(i) && b[0] <= line && line <= b[2]);
  for (const h of hunks) {
    if (h.oldLen) {
      for (let l = h.oldStart; l < h.oldStart + h.oldLen; l++) if (!inBlock(l) || importHit(l)) return true;
    } else {
      const p = h.oldStart; // inserted after old line p: inside a block only if strictly within its span
      const inside = oldBlocks.some((b) => b[0] <= p && p < b[2]);
      const impInside = oldBlocks.some((b, i) => imp.has(i) && b[0] <= p && p < b[2]);
      if (!inside || impInside) return true;
    }
  }
  return false;
}

/**
 * Block id remapping old table → new table through a line diff. A block maps when its whole old
 * span is untouched by the diff and the shifted block exists in the new table with equal columns
 * and kind. Returns (ids) → {ids, ok}; ok=false when any id could not be mapped.
 */
export function makeRemap(oldBlocks, newBlocks, hunks) {
  const { map, cleanSpan } = lineMapper(hunks);
  const idx = new Map();
  newBlocks.forEach((b, i) => { const k = b.join(','); if (!idx.has(k)) idx.set(k, i); });
  const cache = new Map();
  const one = (id) => {
    if (cache.has(id)) return cache.get(id);
    const b = oldBlocks[id];
    let res = -1;
    if (b && cleanSpan(b[0], b[2])) {
      const l1 = map(b[0]), l2 = map(b[2]);
      if (l1 != null && l2 != null) res = idx.get([l1, b[1], l2, b[3], b[4]].join(',')) ?? -1;
    }
    cache.set(id, res);
    return res;
  };
  return (ids) => {
    let ok = true;
    const out = [];
    for (const id of ids) { const n = one(id); if (n < 0) ok = false; else out.push(n); }
    return { ids: [...new Set(out)].sort((a, b) => a - b), ok };
  };
}
