// Runs: start/queue/execute, lane messages, failures, map patch after a run, fix loop.
// Part of the Engine (src/engine.mjs): methods are installed on Engine.prototype, `this` is the engine.
import fs from 'node:fs';
import { select, selectionCount, selectionSpecs, changedFiles, gitHead } from './select.mjs';
import { groupFailures } from './format.mjs';
import { groupOf, truncLines, clearSourceCache } from './format.mjs';
import { redactDeep, outId } from './redact.mjs';
import { listProjectFiles } from './select.mjs';
import { classify, writeEnvJson } from './classify.mjs';
import { userError } from './errors.mjs';

export class RunnerMixin {
  // ------------------------------------------------------------------ runs
  /**
   * kind: affected | full | tests | failed. filters (tests): [{file, line?, name?}] typed only.
   * instrumented:false → "clean" lane (no collector; map not updated) – e.g. the final check.
   */
  async startRun({ kind = 'affected', filters, base, diff, bail = 0, timeoutS, instrumented = true, ids, lane } = {}) {
    const st = this.store;
    const runId = `r${(st.state.runSeq = (st.state.runSeq || 0) + 1)}`;
    // re-runs of failed / explicit tests go to the fix lane while the main lane is busy (no waiting
    // for the main run); they do not patch the map (their tests are marked dirty instead)
    if (!lane) lane = !instrumented ? 'clean' : (kind === 'failed' || kind === 'tests') && this.active && this.mode === 'daemon' ? 'fix' : 'main';
    if (!['main', 'fix', 'clean'].includes(lane)) throw userError('lane must be main, fix or clean');
    if (lane === 'fix' && (kind === 'affected' || kind === 'full')) throw userError('the fix lane only runs failed/explicit tests');
    const run = {
      runId, kind, lane, status: 'queued', createdAt: Date.now(), counts: { pass: 0, fail: 0, skip: 0 }, failures: [], fixed: new Map(),
      total: 0, files: 0, instrumented: lane !== 'clean' && instrumented, waiters: new Set(), events: 0, lastProgress: 0, coverageFiles: new Set(), passedIds: new Set(),
    };
    let specs = null, sel = null;
    if (kind === 'affected') {
      sel = await select(this, { base, diff });
      run.runAll = sel.runAll; run.reasons = sel.reasons; run.hunks = sel.hunks;
      specs = selectionSpecs(this, sel);
      run.total = selectionCount(this, sel);
      if (sel.runAll) run.kind = 'full';
    } else if (kind === 'full') {
      run.total = st.testCount(); run.runAll = true; run.reasons = ['full run requested'];
    } else if (kind === 'tests' || kind === 'failed') {
      specs = kind === 'failed' ? this.failedSpecs(ids) : this.filterSpecs(filters || []);
      if (!specs.length) throw userError(kind === 'failed' ? 'no failed tests to re-run' : 'no test matches the filters');
      run.total = specs.reduce((n, s) => n + (s.names?.length || st.tests.get(st.absOf(s.file))?.tests.size || 1), 0);
    } else throw userError(`unknown run kind "${kind}"`);
    run.specs = specs;
    run.sel = sel;
    run.selArgs = { base, diff };
    run.selGen = this.ingestGen || 0;
    run.filesPlanned = specs ? specs.length : (st.state.testFiles?.length || st.tests.size);
    if (specs && !specs.length) {
      // nothing affected: finished immediately
      run.status = 'done'; run.startedAt = run.endedAt = Date.now(); run.ms = 0;
      this.runs.set(runId, run);
      run.runStartSent = true;
      this.publish(run, { ev: 'run-start', runId, kind: run.kind, total: 0, files: 0, pool: this.poolName(), lane: run.lane });
      this.publish(run, { ev: 'run-end', runId, passed: 0, failed: 0, skipped: 0, ms: 0 });
      run.summary = this.summarize(run);
      this.store.save();
      run.done = Promise.resolve(run.summary);
      return this.envelope({ runId, total: 0, files: 0, kind: run.kind, runAll: false, status: 'done' });
    }
    this.runs.set(runId, run);
    this.pruneRuns();
    this.queues ||= {};
    const q = this.queues[lane] || Promise.resolve();
    run.done = q.then(() => this.execute(run, { bail, timeoutS }), () => this.execute(run, { bail, timeoutS }));
    this.queues[lane] = run.done.catch(() => {});
    return this.envelope({ runId, total: run.total, files: run.filesPlanned, kind: run.kind, lane, runAll: !!run.runAll, reasons: (run.reasons || []).slice(0, 3), status: run.status });
  }

  filterSpecs(filters) {
    const st = this.store;
    const byFile = new Map();
    for (const f of filters) {
      if (typeof f === 'string') throw userError('filters must be objects {file, line?, name?} (typed filters only)');
      if (!f.file && !f.name) throw userError('a filter needs file and/or name');
      const files = f.file ? [st.absOf(f.file)] : [...st.tests.keys()];
      for (const tf of files) {
        const e = st.tests.get(tf);
        if (!e && !fs.existsSync(tf)) throw userError(`test file not found: ${f.file}`);
        let names = null;
        if (f.line != null || f.name) {
          const re = f.name ? safeRegex(f.name) : null;
          const tests = [...(e?.tests.values() || [])];
          let pick = tests.filter((r) => (f.line == null || r.line === f.line) && (!re || re.test(r.name)));
          if (!pick.length && f.line != null) {
            // line inside a test body / describe: nearest test starting at or above the line
            const above = tests.filter((r) => r.line <= f.line && (!re || re.test(r.name))).sort((a, b) => b.line - a.line);
            if (above.length) pick = [above[0]];
          }
          if (!pick.length) { if (!f.file) continue; throw userError(`no test matches ${f.file}${f.line != null ? ':' + f.line : ''}${f.name ? ' /' + f.name + '/' : ''} in the map`); }
          names = pick.map((r) => r.name);
        }
        const cur = byFile.get(tf);
        if (cur === null) continue;
        byFile.set(tf, names === null ? null : [...new Set([...(cur || []), ...names])]);
      }
    }
    return [...byFile].map(([tf, names]) => ({ file: st.relOf(tf), ...(names ? { names } : {}) }));
  }

  failedSpecs(ids) {
    const st = this.store;
    const keys = ids?.length ? ids : Object.keys(st.state.failing);
    const byFile = new Map();
    for (const k of keys) {
      const m = /^(.*?):(\d+) > (.*)$/s.exec(k);
      if (!m) continue;
      const tf = st.absOf(m[1]);
      if (m[2] === '0') { byFile.set(tf, null); continue; }
      const cur = byFile.get(tf);
      if (cur === null) continue;
      // ids leave the engine escaped (redacted + sanitised, N7): the real test name comes from the map;
      // an id the map cannot resolve (escaped name of a test it never recorded) runs the whole file
      const rec = st.tests.get(tf)?.tests.get(k) || st.findByOutId(tf, k);
      let name = rec?.name;
      if (name == null) for (const r of this.runs.values()) { const f = r.failures.find((x) => outId(x.id) === k); if (f) { name = f.name; break; } }
      byFile.set(tf, [...(cur || []), name ?? m[3]]);
    }
    return [...byFile].map(([tf, names]) => ({ file: st.relOf(tf), ...(names ? { names } : {}) }));
  }

  async execute(run, { bail, timeoutS }) {
    const st = this.store;
    const laneName = run.lane;
    const isMain = laneName === 'main';
    if (run.cancelRequested) { run.status = 'cancelled'; run.summary = this.summarize(run); return run.summary; }
    // an affected run queued behind another run: the map changed meanwhile → select again now
    if (run.kind === 'affected' && run.sel && run.selGen !== (this.ingestGen || 0)) {
      const sel = await select(this, run.selArgs);
      Object.assign(run, { sel, runAll: sel.runAll, reasons: sel.reasons, hunks: sel.hunks, specs: selectionSpecs(this, sel), total: selectionCount(this, sel) });
      if (sel.runAll) run.kind = 'full';
      if (run.specs && !run.specs.length) {
        run.status = 'done'; run.startedAt = run.endedAt = Date.now(); run.ms = 0; run.runStartSent = true;
        this.publish(run, { ev: 'run-start', runId: run.runId, kind: run.kind, total: 0, files: 0, pool: this.poolName(), lane: run.lane });
        this.publish(run, { ev: 'run-end', runId: run.runId, passed: 0, failed: 0, skipped: 0, ms: 0 });
        run.summary = this.summarize(run);
        for (const w of run.waiters) w();
        return run.summary;
      }
    }
    run.status = 'running';
    if (isMain) this.active = run;
    // stale map / changed config → fresh Vitest before the run
    if (run.runAll && st.state.stale.length) await this.restartLanes(st.state.stale.join('; '));
    let timer = null;
    try {
      // which lane(s): main runs go to one main lane or, with groups, to the dom + node lanes in parallel
      let plan = [[laneName === 'main' ? this.mainLaneNames()[0] : laneName, run.specs]];
      if (isMain && this.groupsEnabled()) {
        const g = await this.planGroups(run.specs);
        if (g) plan = [['dom', g.dom], ['node', g.node]].filter(([, sp]) => sp.length);
        if (!plan.length) plan = [['dom', []]];
      }
      run.laneNames = plan.map(([n]) => n);
      run.lanesExpected = plan.length;
      const infos = await Promise.all(plan.map(([n]) => this.startLane(n)));
      const info = infos[0];
      run.pool = plan.map(([n], i) => (plan.length > 1 ? `${n}:` : '') + (infos[i].vitestGuard ? `vitest-guard:${infos[i].vitestGuard}` : infos[i].pool)).join('+');
      // snapshot of every changed tracked file at run start (= the version this run executes)
      const snap = new Map();
      for (const [f, c] of changedFiles(this)) if (c.cur) snap.set(f, c.cur.text != null ? c.cur : this.scanner.readText(f));
      run.snapshot = snap;
      if (run.runAll && isMain && run.instrumented) run.listing = run.sel?.listing || await listProjectFiles(this);
      run.startedAt = Date.now();
      if (isMain && this.mode === 'daemon' && this.config.fixLoop && run.instrumented) this.startFixLoop(run);
      const lanes = plan.map(([n]) => this.lane(n));
      const cancelAll = () => lanes.forEach((l) => l.cancel());
      run.cancelLanes = cancelAll;
      if (timeoutS) timer = setTimeout(() => { run.timedOut = true; cancelAll(); }, timeoutS * 1000);
      if (run.cancelRequested) cancelAll();
      run.live = { offsets: new Map(), rest: new Map(), blocks: new Map(), overlay: new Map(), finished: new Set(), storeIdx: new Map(), lastEmit: new Map() };
      const t0 = Date.now();
      const dones = await Promise.all(plan.map(([n, sp], i) => lanes[i].run({ runId: run.runId, specs: sp, bail }, (m) => this.onLaneMessage(run, m, n))));
      const done = mergeDone(dones, Date.now() - t0);
      Object.assign(run, { ms: done.ms, cpuMs: done.cpuMs, laneError: done.error, unhandled: done.unhandled || [], cancelled: done.cancelled || run.cancelRequested, classic: done.classic, laneMs: Object.fromEntries(plan.map(([n], i) => [n, dones[i].ms])) });
      for (const e of run.unhandled.slice(0, 3)) this.addFailure(run, { id: '(unhandled)', file: e.frames?.[0]?.file || '', line: 0, name: '(unhandled error)', errors: [e] });
      if (laneName === 'fix') this.fixLaneResults(run, done);
      else if (laneName === 'clean') this.cleanLaneResults(run, done);
      // map patch
      if (isMain && run.instrumented && !done.error) {
        const now = changedFiles(this);
        const unstable = new Set();
        for (const [f, c] of now) { const s = snap.get(f); if (s && c.cur && c.cur.sha !== s.sha) unstable.add(f); if (!s && c.kind === 'modified') unstable.add(f); }
        const ran = new Map();
        for (const f of done.files) ran.set(f, { full: !run.specs || !run.specs.find((s) => st.absOf(s.file) === f)?.names });
        this.ingestGen = (this.ingestGen || 0) + 1;
        // a run that stopped early must not replace whole test files (tests that never ran would vanish)
        const incomplete = !!(run.cancelled || run.timedOut || (bail > 0 && run.counts.fail >= bail));
        run.mapUpdated = st.ingest(lanes.map((l) => l.rawDir), {
          ran, snapshot: snap, loadFailed: new Set(done.loadFailed), unstable, incomplete,
          readFile: (f) => this.scanner.readText(f),
        });
        for (const id of run.fixed.keys()) st.state.dirtyTests[id] = 1; // re-run during the run by the fix lane
        if (run.runAll && !incomplete && !done.loadFailed.length) {
          st.state.stale = []; st.loadNotes = []; st.state.fullRunAt = new Date().toISOString(); st.state.gitHead = await gitHead(this.root); this.recordTriggers(info);
          // the project file list as it was when this complete run started: later additions are "new files" (C-M2)
          if (run.listing) st.setKnown(run.listing.files);
        }
        this.updateFailing(run, done);
        if (this.groupsEnabled()) { const cls = classify(this, done.files); writeEnvJson(this.root, cls, (f) => st.relOf(f), { log: this.log }); }
      }
    } catch (e) {
      run.laneError = String(e?.message || e);
      this.log(`run ${run.runId} failed: ${e?.stack || e}`);
    } finally {
      if (timer) clearTimeout(timer);
      this.stopFixLoop(run);
      if (!run.runStartSent) this.publishRunStart(run, {});
      run.endedAt = Date.now();
      run.status = run.laneError ? 'error' : run.cancelled || run.timedOut ? 'cancelled' : 'done';
      this.flushCoverage(run, true);
      this.publish(run, { ev: 'run-end', runId: run.runId, passed: run.counts.pass, failed: run.counts.fail, skipped: run.counts.skip, ms: run.ms ?? (run.endedAt - (run.startedAt || run.createdAt)),
        ...(run.cancelled || run.timedOut ? { cancelled: true } : {}), ...(run.laneError ? { error: run.laneError.slice(0, 300) } : {}), ...(run.fixed.size ? { fixedDuringRun: [...run.fixed].filter(([, s]) => s === 'pass').length } : {}) });
      st.state.lastRun = { runId: run.runId, kind: run.kind, at: new Date().toISOString(), passed: run.counts.pass, failed: run.counts.fail };
      try { st.save(); } catch (e) { this.log(`save failed: ${e.stack}`); }
      run.summary = this.summarize(run);
      try { this.metrics.recordRun(this, run); } catch (e) { this.log(`metrics: ${e.stack}`); }
      if (isMain) this.active = null;
      // memory / process budget of warm lanes (A-8): close idle helper lanes when over budget
      this.enforceLaneBudget(this.active?.laneNames || []).catch((e) => this.log(`lane budget: ${e?.message}`));
      clearSourceCache();
      for (const w of run.waiters) w();
      run.waiters.clear();
      if (run.logFd != null) { try { fs.closeSync(run.logFd); } catch {} run.logFd = null; }
    }
    return run.summary;
  }

  onLaneMessage(run, m, laneName) {
    if (m.type === 'ev') {
      const ev = m.ev;
      if (ev.ev === 'test') { run.counts[ev.state]++; run.testMsSum = (run.testMsSum || 0) + (ev.ms || 0); if (ev.state === 'pass') run.passedIds.add(ev.id); this.publish(run, ev, { persist: true, topic: 'test' }); this.progress(run); }
      else if (ev.ev === 'file-start') this.publish(run, ev, { topic: 'test' });
    } else if (m.type === 'failure') {
      this.addFailure(run, m);
    } else if (m.type === 'failure-console') {
      const f = run.failures.find((x) => x.id === m.id);
      if (f && (f.console ||= []).join('').length < 4000) f.console.push(m.line);
    } else if (m.type === 'module-end') {
      run.files++;
      this.liveIngest(run);
      this.progress(run, true);
    } else if (m.type === 'started') {
      // with parallel lanes: one run-start after every lane resolved its specs
      run.started ||= [];
      run.started.push(m);
      if (run.started.length >= (run.lanesExpected || 1)) {
        run.filesPlanned = run.started.reduce((n, x) => n + x.files, 0);
        const projects = {};
        for (const x of run.started) for (const [k, v] of Object.entries(x.projects || {})) projects[k] = [...(projects[k] || []), ...v];
        this.publishRunStart(run, projects);
      }
    }
  }

  /** run-start with per-project totals (files from the lane, tests from the selection / map) */
  publishRunStart(run, projectFiles) {
    if (run.runStartSent) return;
    run.runStartSent = true;
    const st = this.store;
    const spec = new Map((run.specs || []).map((x) => [x.file, x]));
    const projects = {};
    let sum = 0;
    for (const [name, files] of Object.entries(projectFiles)) {
      let tests = 0;
      for (const f of files) { const sp = spec.get(f); tests += sp?.names?.length ?? st.tests.get(st.absOf(f))?.tests.size ?? 0; }
      projects[name] = { files: files.length, tests };
      sum += tests;
    }
    if (!run.total && sum) run.total = sum;
    this.publish(run, { ev: 'run-start', runId: run.runId, kind: run.kind, total: run.total, files: run.filesPlanned, pool: run.pool || this.poolName(), lane: run.lane, ...(Object.keys(projects).length ? { projects } : {}) });
  }

  /**
   * clean-lane runs (no collector, e.g. the final check): the map is NOT touched and NOTHING is
   * marked dirty for passing tests (A-2: that made the next `affected` select the whole suite).
   * Failures are recorded (failing tests are always selected). A test that was recorded as failing
   * and passes now is no longer failing, but its coverage record still comes from a failing run →
   * that one test stays dirty until an instrumented run covers it.
   */
  cleanLaneResults(run) {
    const st = this.store;
    const fl = st.state.failing;
    for (const id of run.passedIds) { const k = outId(id); if (fl[k]) { delete fl[k]; st.state.dirtyTests[id] = 1; } }
    for (const f of run.failures) {
      if (f.id === '(unhandled)') continue;
      fl[outId(f.id)] = redactDeep({ at: Date.now(), runId: run.runId, file: f.file, line: f.line, name: f.name, group: f.group, errors: f.errors.slice(0, 3), console: f.console?.slice(0, 50), coveredChanged: f.coveredChanged });
    }
  }

  /** fix-lane runs: no map patch (the main lane may be running) – update failures, mark tests dirty */
  fixLaneResults(run, done) {
    const st = this.store;
    const fl = st.state.failing;
    for (const id of run.passedIds) { delete fl[outId(id)]; st.state.dirtyTests[id] = 1; }
    for (const f of run.failures) {
      if (f.id === '(unhandled)') continue;
      st.state.dirtyTests[f.id] = 1;
      fl[outId(f.id)] = redactDeep({ at: Date.now(), runId: run.runId, file: f.file, line: f.line, name: f.name, group: f.group, errors: f.errors.slice(0, 3), console: f.console?.slice(0, 50), coveredChanged: f.coveredChanged });
    }
    // a failure of the active main run that now passes counts as fixed during that run
    const main = this.active;
    if (main) for (const id of run.passedIds) if (main.failures.some((f) => f.id === id)) {
      main.fixed.set(id, 'pass');
      const f = main.failures.find((x) => x.id === id); if (f) f.fixed = true;
      this.publish(main, { ev: 'fix-rerun', runId: main.runId, id, state: 'pass' });
    }
  }

  addFailure(run, m) {
    const err = m.errors?.[0] || { message: 'failed without error' };
    const f = {
      seq: run.failures.length + 1, id: m.id, file: m.file, line: m.line, name: m.name, errors: m.errors || [], console: m.console,
      group: groupOf(err, this.root), load: !!m.load, at: Date.now() - (run.startedAt || run.createdAt),
    };
    f.coveredChanged = this.coveredChanged(run, f);
    if (m.load) run.counts.fail++;
    run.failures.push(f);
    if (run.firstFailureMs == null) run.firstFailureMs = f.at;
    const e0 = f.errors[0] || {};
    this.publish(run, {
      ev: 'failure', runId: run.runId, seq: f.seq, id: f.id, file: f.file, line: f.line, name: f.name,
      message: (e0.name ? e0.name + ': ' : '') + String(e0.message ?? '').slice(0, 1000), diff: truncLines(e0.diff, 40),
      frames: (e0.frames || []).slice(0, 3), group: f.group, coveredChanged: f.coveredChanged, ...(f.load ? { load: true } : {}),
    }, { persist: true });
    for (const w of run.waiters) w();
  }

  /** changed lines (new side, "rel:line") inside blocks the failing test covered in the map */
  coveredChanged(run, f) {
    const out = [];
    if (!run.hunks?.size) return out;
    const st = this.store;
    const e = st.tests.get(st.absOf(f.file));
    const rec = e?.tests.get(f.id);
    for (const [file, { rel, hunks }] of run.hunks) {
      if (rel === f.file) { for (const h of hunks) out.push(`${rel}:${h.newStart || 1}`); continue; }
      const ids = rec?.hits?.[file];
      const table = st.blocks.get(file);
      if (!ids || !table) continue;
      const blocks = JSON.parse(table);
      for (const h of hunks) {
        const a = h.oldStart, b = h.oldLen ? h.oldStart + h.oldLen - 1 : h.oldStart;
        if (ids.some((i) => blocks[i] && (h.oldLen ? blocks[i][0] <= b && blocks[i][2] >= a : blocks[i][0] <= a && a < blocks[i][2]))) out.push(`${rel}:${h.newStart || 1}`);
      }
      if (out.length >= 5) break;
    }
    return [...new Set(out)].slice(0, 5);
  }

  updateFailing(run, done) {
    const fl = this.store.state.failing;
    const ranFiles = new Set(done.files.map((f) => this.store.relOf(f)));
    // every test that ran and passed clears its failure; load errors clear when the file loads
    for (const [tf, e] of this.store.tests) {
      const rel = this.store.relOf(tf);
      if (!ranFiles.has(rel)) continue;
      if (!done.loadFailed.includes(tf)) delete fl[`${rel}:0 > (load)`];
    }
    for (const k of Object.keys(fl)) {
      const rel = k.split(':')[0];
      if (!ranFiles.has(rel)) continue;
      const failedNow = run.failures.some((f) => outId(f.id) === k);
      const tf = this.store.absOf(rel);
      const rec = this.store.tests.get(tf)?.tests.get(k) || this.store.findByOutId(tf, k);
      if (!failedNow && (rec?.state === 'pass' || !rec)) delete fl[k];
    }
    for (const f of run.failures) {
      if (f.id === '(unhandled)') continue;
      // persisted redacted, key included (state.json must not keep secrets or control characters from test output)
      fl[outId(f.id)] = redactDeep({ at: Date.now(), runId: run.runId, file: f.file, line: f.line, name: f.name, group: f.group, errors: f.errors.slice(0, 3), console: f.console?.slice(0, 50), coveredChanged: f.coveredChanged });
    }
    const keys = Object.keys(fl);
    for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete fl[k];
  }

  summarize(run) {
    const g = groupFailures(run.failures, 5);
    const mu = run.mapUpdated;
    return this.envelope({
      runId: run.runId, kind: run.kind, status: run.status, ran: run.counts.pass + run.counts.fail + run.counts.skip,
      passed: run.counts.pass, failed: run.counts.fail, skipped: run.counts.skip, total: Math.max(run.total || 0, run.counts.pass + run.counts.fail + run.counts.skip), ms: run.ms ?? 0,
      ...(run.cpuMs != null ? { cpuMs: run.cpuMs } : {}),
      ...(run.firstFailureMs != null ? { firstFailureMs: run.firstFailureMs } : {}),
      failures: g.failures, ...(g.groups > 1 ? { failureGroups: g.groups } : {}), ...(g.more ? { moreFailureGroups: g.more } : {}),
      ...(run.fixed.size ? { fixedDuringRun: [...run.fixed].filter(([, s]) => s === 'pass').map(([id]) => id).slice(0, 5) } : {}),
      runAll: !!run.runAll, ...(run.runAll && run.reasons?.length ? { reasons: run.reasons.slice(0, 3) } : {}),
      instrumented: run.instrumented, pool: run.pool, ...(run.laneMs && Object.keys(run.laneMs).length > 1 ? { laneMs: run.laneMs } : {}),
      ...(mu ? { mapUpdated: { tests: mu.tests, files: mu.recorded, dirty: mu.dirtied } } : {}),
      ...(run.laneError ? { error: run.laneError.slice(0, 400) } : {}), ...(run.timedOut ? { timedOut: true } : {}),
    });
  }

  async waitRun(runId, { timeoutS } = {}) {
    const run = this.getRun(runId);
    if (!timeoutS) return run.done;
    return Promise.race([run.done, new Promise((r) => setTimeout(() => r(this.runStatus({ runId })), timeoutS * 1000))]);
  }

  getRun(runId) {
    const run = runId ? this.runs.get(runId) : [...this.runs.values()].at(-1);
    if (!run) throw userError(runId ? `unknown run ${runId}` : 'no run yet');
    return run;
  }

  runStatus({ runId } = {}) {
    const run = this.getRun(runId);
    const done = run.counts.pass + run.counts.fail + run.counts.skip;
    if (run.summary) return run.summary;
    return this.envelope({ runId: run.runId, kind: run.kind, status: run.status, done, total: run.total, failed: run.counts.fail,
      files: run.files, filesTotal: run.filesPlanned, elapsedMs: run.startedAt ? Date.now() - run.startedAt : 0, failureGroups: new Set(run.failures.map((f) => f.group)).size });
  }

  /** Long-poll: failures after cursor; returns as soon as ≥1 is there, at run end or after waitS. */
  async nextFailures({ runId, cursor, waitS = 20, limit = 5 } = {}) {
    const run = this.getRun(runId);
    const from = cursor ? parseInt(cursor, 10) || 0 : 0;
    const ready = () => run.failures.length > from || run.summary;
    if (!ready() && waitS > 0) {
      await new Promise((resolve) => {
        const t = setTimeout(done, Math.min(30, waitS) * 1000);
        function done() { clearTimeout(t); run.waiters.delete(done); resolve(); }
        run.waiters.add(done);
      });
    }
    const fresh = run.failures.slice(from);
    // groups already returned before this cursor are reported as a count only
    const seenGroups = new Set(run.failures.slice(0, from).map((f) => f.group));
    const repeat = fresh.filter((f) => seenGroups.has(f.group));
    const g = groupFailures(fresh.filter((f) => !seenGroups.has(f.group)), limit);
    const taken = g.failures.reduce((n, f) => n + (f.sameErrorIn || 1), 0);
    const next = from + (g.more ? Math.min(fresh.length, taken + repeat.length) : fresh.length);
    const done = run.counts.pass + run.counts.fail + run.counts.skip;
    return this.envelope({
      runId: run.runId, failures: g.failures, cursor: String(next),
      ...(repeat.length ? { moreOfSeenGroups: repeat.length } : {}), ...(g.more ? { moreGroups: g.more } : {}),
      done: !!run.summary && next >= run.failures.length,
      progress: { done, total: run.total, failed: run.counts.fail, status: run.status },
    });
  }

  cancelRun({ runId } = {}) {
    const run = this.getRun(runId);
    if (run.status === 'running') { run.cancelRequested = true; if (run.cancelLanes) run.cancelLanes(); else this.lane(run.lane).cancel(); }
    else if (run.status === 'queued') { run.cancelRequested = true; }
    return this.envelope({ runId: run.runId, status: run.status === 'running' ? 'cancelling' : run.status });
  }

  async rerunFailed({ runId, ids, lane } = {}) {
    let keys = ids;
    if (!keys?.length && runId) keys = this.getRun(runId).failures.map((f) => f.id).filter((k) => k !== '(unhandled)');
    return this.startRun({ kind: 'failed', ids: keys, lane });
  }

  // ------------------------------------------------------------------ fix loop
  startFixLoop(run) {
    run.fixTimer = setInterval(() => this.fixTick(run).catch((e) => this.log(`fix loop: ${e.stack}`)), 700);
    run.fixTimer.unref?.();
  }
  stopFixLoop(run) { if (run.fixTimer) clearInterval(run.fixTimer); run.fixTimer = null; }
  watchedFilesOf(run, f) {
    const st = this.store;
    const tf = st.absOf(f.file);
    const files = new Set([tf]);
    const rec = st.tests.get(tf)?.tests.get(f.id) || run.live?.overlay.get(f.id);
    for (const k of Object.keys(rec?.hits || {})) files.add(k);
    if (f.load) for (const m of st.tests.get(tf)?.fileload?.modules || []) files.add(m);
    return files;
  }
  async fixTick(run) {
    if (run.fixBusy || run.status !== 'running') return;
    const pending = run.failures.filter((f) => f.id !== '(unhandled)' && run.fixed.get(f.id) !== 'pass');
    if (!pending.length) return;
    // changed = content differs from the version the run (or the last fix re-run) executed
    run.fixBase ||= new Map();
    const baseOf = (file) => run.fixBase.get(file) ?? run.snapshot?.get(file)?.sha ?? this.store.state.files[file]?.sha;
    const due = [];
    const changedNow = new Map();
    for (const f of pending) {
      for (const file of this.watchedFilesOf(run, f)) {
        const cur = this.scanner.read(file)?.sha ?? null;
        if (cur !== (baseOf(file) ?? null)) { changedNow.set(file, cur); due.push(f); break; }
      }
    }
    if (!due.length) return;
    for (const [file, sha] of changedNow) run.fixBase.set(file, sha);
    run.fixBusy = true;
    try {
      const byFile = new Map();
      for (const f of due) { const a = byFile.get(f.file); if (f.line === 0) byFile.set(f.file, null); else if (a !== null) byFile.set(f.file, [...(a || []), f.name]); }
      const specs = [...byFile].map(([file, names]) => ({ file, ...(names ? { names } : {}) }));
      const fixRun = `${run.runId}-f${(run.fixSeq = (run.fixSeq || 0) + 1)}`;
      const seen = new Map();
      const lane = this.lane('fix');
      await lane.run({ runId: fixRun, specs }, (m) => {
        if (m.type === 'ev' && m.ev.ev === 'test') seen.set(m.ev.id, m.ev.state);
        if (m.type === 'failure' && m.load) seen.set(`${m.file}:0 > (load)`, 'fail');
      });
      for (const f of due) {
        let state = seen.get(f.id);
        if (f.line === 0) state = [...seen].some(([k, s]) => k.startsWith(f.file + ':') && s === 'fail') ? 'fail' : seen.size ? 'pass' : 'fail';
        if (!state || state === 'skip') continue;
        run.fixed.set(f.id, state);
        f.fixed = state === 'pass';
        this.publish(run, { ev: 'fix-rerun', runId: run.runId, id: f.id, state });
      }
      for (const w of run.waiters) w();
    } finally { run.fixBusy = false; }
  }

}
/** combine the 'done' messages of parallel lanes into one */
function mergeDone(ds, wallMs) {
  if (ds.length === 1) return ds[0];
  const classic = {};
  for (const d of ds) for (const [k, v] of Object.entries(d.classic || {})) { const c = (classic[k] ||= { chars: 0, endChars: 0 }); c.chars += v.chars; c.endChars += v.endChars; }
  return {
    ms: wallMs, cpuMs: ds.reduce((n, d) => n + (d.cpuMs || 0), 0), files: ds.flatMap((d) => d.files || []), loadFailed: ds.flatMap((d) => d.loadFailed || []),
    unhandled: ds.flatMap((d) => d.unhandled || []), cancelled: ds.some((d) => d.cancelled), classic: Object.keys(classic).length ? classic : null,
    error: ds.map((d) => d.error).filter(Boolean).join('; ') || undefined,
  };
}
function safeRegex(s) { if (String(s).length > 200) throw userError('name pattern too long'); try { return new RegExp(s); } catch { return new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); } }
