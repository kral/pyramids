// In-process mock event source: plays a scenario in real time (or faster) and simulates the
// daemon's request handling (rerun → fix-rerun events, enqueue → ack).
import { fileOfTestId, normalizeEvent, type VtoEvent } from '../events.js';
import type { DaemonRequest, EventSource, SourceHandlers } from '../sources/types.js';
import { buildScenario, mulberry32, type MockOptions, type Timed } from './scenario.js';

export interface MockSourceOptions extends MockOptions {
  /** playback speed multiplier */
  speed?: number;
  /** tick in ms (events due in the same tick are delivered as one batch) */
  tickMs?: number;
  /** probability a rerun turns green */
  rerunPassRate?: number;
  /** override the clock (tests) */
  now?: () => number;
}

export class MockSource implements EventSource {
  readonly canRequest = true;
  readonly label = 'mock';
  readonly timeline: Timed[];
  private i = 0;
  private timer: NodeJS.Timeout | null = null;
  private t0 = 0;
  private h: SourceHandlers | null = null;
  private rnd: () => number;
  private failedIds = new Map<string, Set<string>>();
  private fixed = new Set<string>();
  private failures = new Map<string, Extract<VtoEvent, { ev: 'failure' }>>();
  private runSeq = 0;
  private queue: unknown[] = [];
  private now: () => number;
  readonly requests: DaemonRequest[] = [];

  constructor(private o: MockSourceOptions) {
    this.timeline = buildScenario(o);
    this.rnd = mulberry32(o.seed ^ 0x9e3779b9);
    this.now = o.now ?? (() => performance.now());
  }

  start(h: SourceHandlers): void {
    this.h = h;
    h.onStatus?.('live');
    this.t0 = this.now();
    const tick = this.o.tickMs ?? 16;
    this.timer = setInterval(() => this.pump(), tick);
    this.pump();
  }

  /** deliver everything due; returns number of events delivered */
  pump(): number {
    const el = (this.now() - this.t0) * (this.o.speed ?? 1);
    const batch: VtoEvent[] = [];
    while (this.i < this.timeline.length && this.timeline[this.i].at <= el) {
      const ev = normalizeEvent(this.timeline[this.i++].ev);
      if (ev) { this.track(ev); batch.push(ev); }
    }
    if (batch.length) this.h?.onEvents(batch);
    if (this.i >= this.timeline.length && this.timer) { clearInterval(this.timer); this.timer = null; }
    return batch.length;
  }

  /** Deliver the remaining scenario at once (tests, benchmarks). */
  drain(batchSize = Infinity): void {
    while (this.i < this.timeline.length) {
      const batch: VtoEvent[] = [];
      while (this.i < this.timeline.length && batch.length < batchSize) {
        const ev = normalizeEvent(this.timeline[this.i++].ev);
        if (ev) { this.track(ev); batch.push(ev); }
      }
      this.h?.onEvents(batch);
    }
  }

  get finished(): boolean { return this.i >= this.timeline.length; }

  private track(ev: VtoEvent) {
    if (ev.ev === 'run-start') this.runSeq = Math.max(this.runSeq, Number(ev.runId.replace(/\D/g, '')) || 0);
    if (ev.ev === 'failure') {
      let s = this.failedIds.get(ev.runId); if (!s) this.failedIds.set(ev.runId, (s = new Set()));
      s.add(ev.id);
      if (!this.failures.has(ev.id)) this.failures.set(ev.id, ev);
    } else if (ev.ev === 'fix-rerun' && ev.state === 'pass') this.fixed.add(ev.id);
    else if (ev.ev === 'test' && ev.state === 'pass' && this.failures.has(ev.id)) this.fixed.add(ev.id); // green in a rerun
  }

  async request(req: DaemonRequest): Promise<unknown> {
    this.requests.push(req);
    if (req.method === 'rerun_failed') {
      // like the real daemon (engine.rerunFailed): a new run of kind "failed" with just these tests
      const known = this.failedIds.get(req.params.runId) ?? new Set<string>();
      const ids = req.params.ids?.length ? req.params.ids.filter((id) => known.has(id)) : [...known].filter((id) => !this.fixed.has(id));
      const runId = `r${++this.runSeq}`;
      const pass = this.o.rerunPassRate ?? 0.75;
      const speed = this.o.speed ?? 1;
      const emit = (ev: VtoEvent, at: number) => { const t = setTimeout(() => { this.track(ev); this.h?.onEvents([ev]); }, at / speed); t.unref?.(); };
      let at = 200;
      emit({ ev: 'run-start', runId, kind: 'failed', total: ids.length, files: new Set(ids.map(fileOfTestId)).size, pool: this.o.pool }, at);
      let passed = 0, failed = 0, seq = 0;
      for (const id of ids) {
        at += 100 + this.rnd() * 300;
        const ok = this.rnd() < pass;
        emit({ ev: 'test', runId, id, state: ok ? 'pass' : 'fail', ms: 20 }, at);
        if (ok) passed++;
        else {
          failed++;
          const orig = this.failures.get(id);
          if (orig) emit({ ...orig, runId, seq: ++seq }, at + 1);
        }
      }
      emit({ ev: 'run-end', runId, passed, failed, skipped: 0, ms: Math.round(at) }, at + 20);
      return { v: 'vto/1', runId, total: ids.length, status: 'queued' };
    }
    if (req.method === 'enqueue_task') {
      this.queue.push(req.params.task);
      return { queued: true, position: this.queue.length };
    }
    throw Object.assign(new Error(`mock: method ${(req as { method: string }).method} not mocked`), { code: 'E_METHOD' });
  }

  close(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
