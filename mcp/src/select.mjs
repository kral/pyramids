// Affected-test selection against the map (stateless: everything it needs is in MapStore + disk).
//
// Diff old side = the version each file had when the map was recorded (.vto/blobs), so edits that
// are not committed (the normal agent loop) are handled without git. `base` (git ref) adds every
// line that differs between the recorded version and `base`, i.e. "everything this branch changed".
// Always added: dirty tests/files (map entries that could not be remapped), previously failing
// tests, new test files, changed test files (whole file, also for new tests in it).
//
// One selection engine (U-5): WHICH tests a diff affects is decided by the Rust analyzer (the same
// binary and rules as `vto affected`, contracts/DECISIONS.md D5). This module only builds the diff
// (recorded version → working tree, new files, optional base) and adds what the daemon knows on top:
// dirty marks, previously failing tests, test files the map has never seen, and – as a safety net
// that can only ADD tests – every loader/reader of a changed file that has no block table.
import fs from 'node:fs';
import path from 'node:path';
import { diffLines, unifiedDiff } from './diff.mjs';
import { normText, slash, sha1 } from './platform.mjs';
import { relKey, canonicalFile } from './paths.mjs';
import * as git from './git.mjs';
import * as analyzer from './analyzer.mjs';

export const BASE_RE = git.BASE_RE;
export const validBase = git.validBase;
export const resolveBase = (root, base) => git.resolveRev(root, base);
export const gitHead = (root) => git.head(root);

/** Changed trigger files (rel) vs the hashes recorded when the map/lanes were set up. */
export function changedTriggers(eng) {
  const out = [];
  const t = eng.store.state.triggers || {};
  for (const f of Object.keys(t)) {
    const c = eng.scanner.read(f);
    if ((c?.sha ?? null) !== t[f]) out.push(eng.store.relOf(f));
  }
  return out;
}

/** Tracked files whose working-tree content differs from the recorded version. */
export function changedFiles(eng) {
  const st = eng.store;
  const out = new Map(); // abs → {kind, rec, cur}
  for (const f of st.trackedFiles()) {
    const rec = st.state.files[f];
    const cur = eng.scanner.read(f);
    if (!cur) { if (rec) out.set(f, { kind: 'deleted', rec }); continue; }
    if (!rec) { out.set(f, { kind: 'unknown', cur }); continue; }
    if (cur.sha !== rec.sha) out.set(f, { kind: 'modified', rec, cur });
  }
  return out;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.vto', '.hg', '.svn']);
const OWN = /^(?:\.vto|\.git|node_modules)(?:\/|$)|(?:^|\/)node_modules\/|^\.vitest-guard\/run\//;

/**
 * Every project file a test could pick up (root-relative keys): what git tracks or would add
 * (ignored build output is not listed), plus the entries of every directory that holds a file of
 * the map (generated, git-ignored sources). No git → a bounded walk of the tree.
 * → {files:Set<rel>, source:'git'|'walk'} | null (cannot list ⇒ caller answers run all)
 */
export async function listProjectFiles(eng) {
  const st = eng.store;
  const out = new Set();
  const names = await git.listFiles(eng.root);
  let source = 'git';
  if (names) { for (const n of names) { const k = slash(n); if (!OWN.test(k)) out.add(k); } }
  else {
    source = 'walk';
    let budget = 200000;
    const walk = (dir, relDir) => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (--budget < 0) return;
        const r = relDir ? `${relDir}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !OWN.test(r + '/')) walk(path.join(dir, e.name), r); }
        else if (e.isFile()) out.add(slash(r));
      }
    };
    walk(eng.root, '');
    if (budget < 0) return null;
  }
  const dirs = new Set();
  for (const f of st.trackedFiles()) if (f.startsWith(eng.root + '/') && !f.includes('/node_modules/')) dirs.add(path.posix.dirname(f));
  for (const d of dirs) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) if (e.isFile()) { const k = relKey(eng.root, `${d}/${slash(e.name)}`); if (!OWN.test(k)) out.add(k); }
  }
  return { files: out, source };
}

/** project files that exist now and were not there at the last complete full run (and are not in the map) */
export async function newFiles(eng, listing) {
  const st = eng.store;
  if (!st.known) return [];
  const tracked = st.trackedFiles();
  const out = [];
  for (const k of listing.files) if (!st.known.has(k) && !tracked.has(st.absOf(k))) out.push(k);
  return out.sort();
}

export async function select(eng, { base, diff, importers = false } = {}) {
  const st = eng.store;
  const sel = { runAll: false, reasons: [], files: new Map(), keys: new Set(), changed: [], hunks: new Map(), notes: [], total: st.testCount() };
  if (!st.hasMap()) { sel.runAll = true; sel.reasons.push(...(st.loadNotes.length ? st.loadNotes : []), ...st.state.stale, 'no coverage map yet (the first run records it)'); return sel; }
  const trig = changedTriggers(eng);
  if (trig.length) { for (const r of trig) st.addStale(`changed: ${r}`); }
  if (st.state.stale.length) { sel.runAll = true; sel.reasons.push(...st.state.stale); return sel; }
  const runAll = (reason) => { sel.runAll = true; sel.reasons.push(reason); return sel; };

  const addFile = (tf, full = true) => { const e = sel.files.get(tf) || { full: false, names: new Set() }; if (full) e.full = true; sel.files.set(tf, e); return e; };
  const addKey = (key) => {
    const m = /^(.*?):(\d+) > (.*)$/s.exec(key);
    if (!m) return;
    const tf = st.absOf(m[1]);
    if (!st.tests.has(tf)) { if (fs.existsSync(tf)) addFile(tf); return; }
    if (m[2] === '0' && /^\((load|suite)/.test(m[3])) { addFile(tf); return; }
    const e = st.tests.get(tf);
    const rec = e.tests.get(key) || st.findByOutId(tf, key);
    if (!rec) { addFile(tf); return; } // test vanished / renamed: run the whole file
    addFile(tf, false).names.add(rec.name);
    sel.keys.add(st.key(rec));
  };

  // test file list (new / deleted test files)
  const list = await eng.testFileList();
  const testSet = new Set(list || []);
  if (list) {
    for (const tf of [...st.tests.keys()]) if (!testSet.has(tf) && !fs.existsSync(tf)) { st.removeTestFile(tf); sel.notes.push(`deleted test file ${st.relOf(tf)}`); }
    for (const tf of list) if (!st.tests.has(tf)) { addFile(tf); sel.changed.push(st.relOf(tf)); sel.notes.push(`new test file ${st.relOf(tf)}`); }
  }

  const changes = changedFiles(eng);
  let diffText = '';
  for (const [f, c] of changes) {
    const rel = st.relOf(f);
    sel.changed.push(rel);
    if (st.tests.has(f)) { if (c.kind !== 'deleted') addFile(f); continue; } // changed test file: whole file
    // safety net (only adds): a file without a block table (json, css, md, anything read through fs, a
    // module the collector could not instrument) has no finer unit than "everything that loads or reads it"
    if (!st.blocks.has(f)) for (const tf of st.loadersOf(f)) addFile(tf);
    if (c.kind === 'unknown') { for (const tf of st.loadersOf(f)) addFile(tf); continue; }
    const oldText = st.readBlob(c.rec.sha);
    if (oldText == null) { for (const tf of st.loadersOf(f)) addFile(tf); sel.notes.push(`no recorded copy of ${rel}: all its loaders selected`); continue; }
    const newText = c.kind === 'deleted' ? null : (c.cur.text ?? eng.scanner.readText(f)?.text ?? '');
    const hunks = diffLines(normText(oldText), newText == null ? '' : normText(newText));
    sel.hunks.set(f, { rel, hunks });
    diffText += unifiedDiff(rel, c.kind === 'deleted' ? null : rel, normText(oldText), newText == null ? null : normText(newText), hunks);
  }

  // new (or renamed-to) non-test files since the last complete full run (C-M2, D5.4): a glob import,
  // readdir, __mocks__ or module resolution can pick them up without any edit to a known file.
  // They go to the analyzer as additions; it applies the shared rule (ignored → nothing, unknown
  // source file → run all). Recorded directory reads narrow that to the readers.
  const listing = await listProjectFiles(eng);
  if (!listing) return runAll('the project file list could not be read (new files cannot be ruled out)');
  sel.listing = listing;
  if (!st.known) {
    // maps recorded before new-file detection existed: adopt the current tree, say so once
    st.setKnown(listing.files);
    sel.notes.push('project file list recorded now: files added before this point cannot be detected (a full run makes the map exact)');
  }
  for (const k of await newFiles(eng, listing)) {
    const f = st.absOf(k);
    if (testSet.has(f) || st.tests.has(f)) continue; // new test files are selected above
    sel.changed.push(k);
    (sel.newFiles ||= []).push(k);
    const readers = st.dirReaders(path.posix.dirname(f));
    for (const tf of readers) addFile(tf);
    let text = '';
    try { const s = fs.statSync(f); if (s.size <= 2 << 20) text = fs.readFileSync(f, 'utf8'); } catch {}
    const nt = normText(text);
    diffText += unifiedDiff(null, k, null, nt, nt ? [{ oldStart: 0, oldLen: 0, newStart: 1, newLen: nt.replace(/\n$/, '').split('\n').length }] : []);
  }

  if (base) {
    // F1: never pass a client string to git as an option; resolve to a commit sha first (hardened git, D4)
    const sha = await git.resolveRev(eng.root, base);
    if (!sha) return runAll('base could not be resolved to a commit (invalid ref or no git): running all');
    base = sha;
    const info = {};
    const names = await git.diffNames(eng.root, sha, info); // -z, core.quotePath=false: names are never quoted (S-N2b)
    if (names == null) return runAll(`git diff against "${base}" failed (${info.error || 'no git repo or unknown ref'})`);
    const top = (await git.topLevel(eng.root)) || eng.root;
    for (const n of names) {
      const f = st.canon(canonicalFile(path.resolve(top, n)));
      const rel = st.relOf(f);
      if (!f.startsWith(eng.root + '/') || OWN.test(rel)) continue; // another package of a monorepo / vto's own state
      if (st.tests.has(f) || testSet.has(f)) { if (fs.existsSync(f)) addFile(f); continue; }
      if (!st.state.files[f]) {
        if (sel.changed.includes(rel)) continue; // already handled above as a new file
        // changed since base and unknown to the map: the same rule as a new file (the analyzer decides;
        // a deleted unknown file cannot affect a test the map knows)
        if (!fs.existsSync(f)) { sel.notes.push(`changed since ${base.slice(0, 12)}, deleted and not in map: ${rel}`); continue; }
        sel.changed.push(rel);
        for (const tf of st.dirReaders(path.posix.dirname(f))) addFile(tf);
        const was = await git.blobAt(eng.root, sha, slash(n));
        let now = ''; try { if (fs.statSync(f).size <= 2 << 20) now = normText(fs.readFileSync(f, 'utf8')); } catch {}
        if (was) { const o = normText(was.toString('utf8')); const hs = diffLines(o, now); diffText += hs.length ? unifiedDiff(rel, rel, o, now, hs) : `diff --git a/${rel} b/${rel}\n--- a/${rel}\n+++ b/${rel}\n@@ -1 +1 @@\n-\n+ \n`; }
        else diffText += unifiedDiff(null, rel, null, now || '\n', [{ oldStart: 0, oldLen: 0, newStart: 1, newLen: Math.max(1, now.replace(/\n$/, '').split('\n').length) }]);
        continue;
      }
      const oldText = st.readBlob(st.state.files[f].sha);
      const baseBuf = await git.blobAt(eng.root, sha, slash(n));
      if (oldText == null || !st.blocks.has(f)) { for (const tf of st.loadersOf(f)) addFile(tf); if (oldText == null) continue; }
      const baseText = baseBuf ? baseBuf.toString('utf8') : '';
      const hunks = diffLines(normText(oldText), normText(baseText));
      if (!hunks.length) continue;
      if (!sel.changed.includes(rel)) sel.changed.push(rel);
      diffText += unifiedDiff(rel, rel, normText(oldText), normText(baseText), hunks);
    }
  }
  if (diff) diffText += (diffText && !diffText.endsWith('\n') ? '\n' : '') + diff;

  if (diffText) {
    const a = await analyzer.affected(eng.root, st.mapDir, diffText, { importers });
    if (a.runAll) { sel.runAll = true; sel.reasons.push(...(a.reasons?.length ? a.reasons : ['analyzer: run all'])); return sel; }
    for (const t of a.tests) addKey(`${t.file}:${t.line ?? 0} > ${t.name}`);
    // file-level answers (D5.1): whole test files, also ones the map does not know yet
    for (const tf of a.files || a.testFiles || []) if (typeof tf === 'string') addFile(st.absOf(tf.replace(/^\.\//, '')));
    if (a.warnings?.length) sel.notes.push(...a.warnings.filter((w) => !/allow-stale/.test(w)).map((w) => w.replace(/^vto: /, '')));
  }
  for (const k of Object.keys(st.state.dirtyTests)) addKey(k);
  for (const tf of Object.keys(st.state.dirtyFiles)) if (st.tests.has(tf)) addFile(tf);
  for (const k of Object.keys(st.state.failing)) addKey(k);

  // whole file when every test of it is selected (replaces the shard completely)
  for (const [tf, e] of sel.files) {
    const n = st.tests.get(tf)?.tests.size ?? 0;
    if (!e.full && n && e.names.size >= n) e.full = true;
  }
  return sel;
}

export function selectionCount(eng, sel) {
  if (sel.runAll) return sel.total;
  let n = 0;
  for (const [tf, e] of sel.files) n += e.full ? (eng.store.tests.get(tf)?.tests.size || 1) : e.names.size;
  return n;
}

export function selectionSpecs(eng, sel) {
  if (sel.runAll) return null;
  return [...sel.files].map(([tf, e]) => ({ file: eng.store.relOf(tf), ...(e.full ? {} : { names: [...e.names] }) }));
}

export const selId = (x) => sha1(JSON.stringify(x)).slice(0, 12);
