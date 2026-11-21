// Events: publish + run log (.vto/runs), progress, live coverage overlay and coverage events.
// Part of the Engine (src/engine.mjs): methods are installed on Engine.prototype, `this` is the engine.
import fs from 'node:fs';
import path from 'node:path';
import { makeRemap, absRecord } from './store.mjs';
import { computeCoverage } from './coverage.mjs';
import { diffLines } from './diff.mjs';
import { redactDeep } from './redact.mjs';
import { openPrivate } from './safefs.mjs';
import { normText } from './platform.mjs';

export class EventsMixin {
  progress(run, force = false) {
    const now = Date.now();
    if (!force && now - run.lastProgress < 250) return;
    run.lastProgress = now;
    const done = run.counts.pass + run.counts.fail + run.counts.skip;
    const el = now - run.startedAt;
    const total = Math.max(run.total, done);
    this.publish(run, { ev: 'progress', runId: run.runId, done, failed: run.counts.fail, etaMs: done ? Math.round((el / done) * (total - done)) : null, total, files: run.files, filesTotal: run.filesPlanned });
  }

  publish(run, ev, { persist = true, topic } = {}) {
    ev = redactDeep(ev);
    run.events++;
    if (persist && (ev.ev !== 'coverage' || ev.complete)) {
      try {
        if (run.logFd == null) run.logFd = openPrivate(this.sd.file('runs', `${run.runId}.jsonl`), 'a'); // N5/F11: no symlink followed, 0600
        fs.writeSync(run.logFd, JSON.stringify(ev) + '\n');
      } catch {}
    }
    this.emit('event', ev, topic || (ev.ev === 'coverage' ? 'coverage' : 'run'));
  }

  pruneRuns() {
    const ids = [...this.runs.keys()];
    for (const id of ids.slice(0, Math.max(0, ids.length - 20))) if (this.runs.get(id).status !== 'running' && this.runs.get(id).status !== 'queued') this.runs.delete(id);
    try {
      if (!this.sd.exists('runs')) return;
      const d = this.sd.dir('runs');
      const fsRuns = fs.readdirSync(d).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
      for (const n of fsRuns.slice(0, Math.max(0, fsRuns.length - 30))) fs.rmSync(path.join(d, n), { force: true });
    } catch {}
  }

  // ------------------------------------------------------------------ live coverage
  /** Read new raw records of the main lane after a test file finished; merge into the run overlay. */
  liveIngest(run) {
    const L = run.live;
    if (!L || !run.instrumented || run.lane !== 'main') return; // fix/clean lanes do not feed live coverage
    const touched = new Set();
    const entries = [];
    for (const ln of run.laneNames || ['main']) {
      const dir = this.lane(ln).rawDir;
      try { for (const n of fs.readdirSync(dir)) if (n.endsWith('.jsonl')) entries.push([ln + '/' + n, path.join(dir, n)]); } catch {}
    }
    for (const [n, p] of entries) {
      let size;
      try { size = fs.statSync(p).size; } catch { continue; }
      const off = L.offsets.get(n) || 0;
      if (size <= off) continue;
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(size - off);
      fs.readSync(fd, buf, 0, buf.length, off);
      fs.closeSync(fd);
      L.offsets.set(n, size);
      const text = (L.rest.get(n) || '') + buf.toString('utf8');
      const lines = text.split('\n');
      L.rest.set(n, lines.pop());
      for (const l of lines) {
        if (!l) continue;
        let r; try { r = absRecord(this.root, JSON.parse(l)); } catch { continue; }
        if (r.t === 'file') L.blocks.set(r.file, r.blocks);
        else if (r.t === 'test') { for (const k in r.hits) touched.add(k); L.overlay.set(this.store.key(r), r); }
        else if (r.t === 'fileload') L.finished.add(r.testFile);
      }
    }
    for (const f of touched) run.coverageFiles.add(f);
    if (this.coverageSubs > 0) { for (const f of touched) (run.covPending ||= new Set()).add(f); this.flushCoverage(run, false); }
  }

  /** hits per test for file f: map records (remapped to this run's table) overlaid with this run's records */
  liveHits(run, f) {
    const st = this.store;
    const L = run?.live;
    const runTable = L?.blocks.get(f);
    const storeTable = st.blocks.get(f) ? JSON.parse(st.blocks.get(f)) : null;
    const table = runTable || storeTable;
    if (!table) return null;
    let base = L?.storeIdx.get(f);
    if (!base) {
      base = new Map();
      let remap = null;
      if (runTable && storeTable && JSON.stringify(runTable) !== JSON.stringify(storeTable)) {
        const rec = st.state.files[f];
        const oldText = rec && st.readBlob(rec.sha);
        const cur = run.snapshot?.get(f) || this.scanner.readText(f);
        remap = oldText != null && cur?.text != null ? makeRemap(storeTable, runTable, diffLines(normText(oldText), normText(cur.text))) : () => ({ ids: [], ok: false });
      }
      for (const e of st.tests.values()) for (const [k, r] of e.tests) {
        const ids = r.hits?.[f];
        if (!ids) continue;
        base.set(k, remap ? remap(ids).ids : ids);
      }
      if (L) L.storeIdx.set(f, base);
    }
    const hits = new Map(base);
    if (L) {
      // a fully re-run test file replaces all its old records once it finished
      for (const k of hits.keys()) { const tf = st.absOf(k.split(':')[0]); if (L.finished.has(tf) && !run.specs?.find((s) => st.absOf(s.file) === tf)?.names) hits.delete(k); }
      for (const [k, r] of L.overlay) { if (r.hits[f]) hits.set(k, r.hits[f]); else hits.delete(k); }
    }
    return { table, hits, sha: run?.snapshot?.get(f)?.sha || st.state.files[f]?.sha || this.scanner.read(f)?.sha || null };
  }

  coverageEvent(run, f, complete) {
    const h = this.liveHits(run, f);
    if (!h) return null;
    const text = this.scanner.readText(f);
    const c = computeCoverage(h.table, h.hits, { text: text && text.sha === h.sha ? text.text : undefined, cap: this.config.coverageCap });
    return { ev: 'coverage', runId: run?.runId ?? null, file: this.store.relOf(f), hash: h.sha, lines: c.lines, branches: c.branches, testsByLine: c.testsByLine, ...(Object.keys(c.more).length ? { more: c.more } : {}), complete };
  }

  flushCoverage(run, final) {
    if (this.coverageSubs <= 0 || !run.live) return;
    const now = Date.now();
    const files = final ? run.coverageFiles : (run.covPending || new Set());
    for (const f of [...files]) {
      if (!final && now - (run.live.lastEmit.get(f) || 0) < 300) continue;
      run.live.lastEmit.set(f, now);
      run.covPending?.delete(f);
      if (!f.startsWith(this.root + '/') || f.includes('/node_modules/')) continue;
      const ev = this.coverageEvent(run, f, final);
      if (ev) this.publish(run, ev, { persist: final, topic: 'coverage' });
    }
  }

}
