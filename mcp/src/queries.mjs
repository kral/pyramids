// Read-only queries on the map: coverage, tests for a line, lines of a test, why_failed.
// Part of the Engine (src/engine.mjs): methods are installed on Engine.prototype, `this` is the engine.
import fs from 'node:fs';
import path from 'node:path';
import { page, ranges, truncLines } from './format.mjs';
import { testsForLine } from './coverage.mjs';
import { diffLines } from './diff.mjs';
import { normText } from './platform.mjs';
import { userError } from './errors.mjs';
import { outId } from './redact.mjs';

export class QueriesMixin {
  // ------------------------------------------------------------------ coverage queries
  activeRunFor() { return this.active?.live ? this.active : null; }

  coverage({ file, live = true, detail = 'summary', limit = 50, cursor } = {}) {
    if (!file) throw userError('file is required');
    const f = this.store.absOf(file);
    const run = live ? this.activeRunFor() : null;
    const ev = this.coverageEvent(run, f, !run);
    if (!ev) return this.envelope({ file, known: false, note: 'no coverage recorded for this file (not loaded by any test in the map)' });
    const cur = this.scanner.read(f);
    const out = {
      file: ev.file, hash: ev.hash, editedSinceRecord: !!cur && cur.sha !== ev.hash, complete: ev.complete, runId: ev.runId,
      covered: ranges(ev.lines.covered), partial: ranges(ev.lines.partial), uncovered: ranges(ev.lines.uncovered),
      counts: { covered: ev.lines.covered.length, partial: ev.lines.partial.length, uncovered: ev.lines.uncovered.length },
    };
    if (detail === 'full') {
      const lines = Object.keys(ev.testsByLine).map(Number).sort((a, b) => a - b);
      const p = page(lines, { limit, cursor });
      // consecutive lines covered by the same tests are merged ("9-10": [...])
      const tb = {};
      let prevKey = null, start = null, prevLine = null;
      const flush = () => { if (start == null) return; const ids = ev.testsByLine[start]; const more = (ev.more?.[start] || 0) + Math.max(0, ids.length - 2); tb[start === prevLine ? `${start}` : `${start}-${prevLine}`] = ids.slice(0, 2).concat(more ? [`+${more} more (tests_for_line)`] : []); };
      for (const l of p.items) {
        const key = JSON.stringify(ev.testsByLine[l]) + (ev.more?.[l] || 0);
        if (key === prevKey && l === prevLine + 1) { prevLine = l; continue; }
        flush(); prevKey = key; start = l; prevLine = l;
      }
      flush();
      out.testsByLine = tb;
      out.branches = Object.fromEntries(p.items.filter((l) => ev.branches[l]).map((l) => [l, ev.branches[l]]));
      if (p.cursor) out.cursor = p.cursor;
    }
    return this.envelope(out);
  }

  testsFor({ file, line, limit = 20, cursor } = {}) {
    if (!file || !line) throw userError('file and line are required');
    const f = this.store.absOf(file);
    const h = this.liveHits(this.activeRunFor(), f);
    if (!h) return this.envelope({ file, line, tests: [], total: 0, known: false });
    const all = testsForLine(h.table, h.hits, line).sort();
    const p = page(all, { limit, cursor });
    return this.envelope({ file, line, tests: p.items, total: p.total, ...(p.cursor ? { cursor: p.cursor } : {}) });
  }

  linesFor({ test, limit = 30, cursor } = {}) {
    if (!test) throw userError('test is required');
    const st = this.store;
    const rec = this.findTest(test);
    if (!rec) return this.envelope({ test, known: false });
    const out = [];
    for (const [f, ids] of Object.entries(rec.hits || {})) {
      const table = st.blocks.get(f) ? JSON.parse(st.blocks.get(f)) : null;
      if (!table) continue;
      const lines = [];
      for (const i of ids) { const b = table[i]; if (b) for (let l = b[0]; l <= Math.min(b[2], b[0] + 400); l++) lines.push(l); }
      out.push({ file: st.relOf(f), blocks: ids.length, lines: ranges(lines) });
    }
    out.sort((a, b) => b.blocks - a.blocks);
    const p = page(out, { limit, cursor });
    return this.envelope({ test: st.key(rec), files: p.items, filesTotal: p.total, ...(p.cursor ? { cursor: p.cursor } : {}) });
  }

  findTest(id) {
    const st = this.store;
    const m = /^(.*?):(\d+)(?: > (.*))?$/s.exec(id);
    if (!m) return null;
    const e = st.tests.get(st.absOf(m[1]));
    if (!e) return null;
    if (m[3] != null) return e.tests.get(id) || null;
    const line = +m[2];
    let best = null;
    for (const r of e.tests.values()) if (r.line === line) return r; else if (r.line < line && (!best || r.line > best.line)) best = r;
    return best;
  }

  // ------------------------------------------------------------------ why_failed
  whyFailed({ test } = {}) {
    if (!test) throw userError('test is required');
    const st = this.store;
    // ids reach agents escaped (redacted + sanitised, redact.outId); state.failing is keyed by that
    // form, and the raw form typed by a person must work too (N7: a failure must never be un-inspectable)
    const want = outId(test);
    let f = st.state.failing[want] || st.state.failing[test];
    let key = st.state.failing[want] ? want : test;
    if (!f) {
      // prefix match "file:line" or "file:line > name" from the latest runs
      const cands = Object.keys(st.state.failing).filter((k) => k.startsWith(want) || k.includes(want) || outId(k) === want);
      if (cands.length) { key = cands[0]; f = st.state.failing[key]; }
      else for (const r of [...this.runs.values()].reverse()) { const x = r.failures.find((y) => y.id === test || outId(y.id) === want || outId(y.id).startsWith(want)); if (x) { f = x; key = x.id; break; } }
    }
    if (!f) return this.envelope({ test, failing: false, note: 'no recorded failure for this test (it passed in its last run or never ran)' });
    const e = f.errors?.[0] || {};
    const rec = this.findTest(key) || this.store.findByOutId(st.absOf(String(f.file || key.split(':')[0])), key);
    const covered = [];
    if (rec) {
      for (const [file, ids] of Object.entries(rec.hits || {})) {
        const fr = st.state.files[file];
        if (!fr?.prevSha || Date.now() - fr.at > 6 * 3600e3) continue;
        const a = st.readBlob(fr.prevSha), b = st.readBlob(fr.sha), table = st.blocks.get(file);
        if (a == null || b == null || !table) continue;
        const blocks = JSON.parse(table);
        const hunks = diffLines(normText(a), normText(b));
        for (const h of hunks) {
          if (!h.newLen) continue;
          const s = h.newStart, t = h.newStart + h.newLen - 1;
          if (ids.some((i) => blocks[i] && blocks[i][0] <= t && blocks[i][2] >= s)) covered.push(`${st.relOf(file)}:${s}${t > s ? '-' + t : ''}`);
        }
      }
    }
    const frames = (e.frames || []).slice(0, 10);
    const ctx = frames[0] ? sourceContext(path.join(this.root, frames[0].file), frames[0].line) : undefined;
    const con = f.console?.length ? dedupe(f.console).join('\n').slice(0, 2000) : undefined;
    return this.envelope({
      test: key, file: f.file, line: f.line, name: f.name, group: f.group,
      error: (e.name ? e.name + ': ' : '') + String(e.message ?? '').slice(0, 2000),
      ...(e.diff ? { diff: truncLines(e.diff, 80, 6000) } : {}), frames, ...(ctx ? { source: ctx } : {}),
      ...(f.errors?.length > 1 ? { otherErrors: f.errors.slice(1, 3).map((x) => String(x.message).split('\n')[0].slice(0, 300)) } : {}),
      ...(con ? { console: con } : {}),
      coveredChanged: [...new Set([...(f.coveredChanged || []), ...covered])].slice(0, 10),
    });
  }

}
function dedupe(lines) { const m = new Map(); for (const l of lines) m.set(l, (m.get(l) || 0) + 1); return [...m].map(([l, n]) => (n > 1 ? `${l} (×${n})` : l)); }
function sourceContext(file, line) {
  try {
    const l = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const out = [];
    for (let i = Math.max(1, line - 2); i <= Math.min(l.length, line + 2); i++) out.push(`${i === line ? '>' : ' '}${i}| ${l[i - 1].slice(0, 160)}`);
    return out.join('\n');
  } catch { return undefined; }
}
