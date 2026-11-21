import { describe, it, expect } from 'vitest';
import { RunStore, fallbackGroupKey } from '../src/model.js';
import { normalizeEvent, parseLine, LineSplitter, fileOfTestId, lineOfTestId, nameOfTestId, type VtoEvent } from '../src/events.js';
import { buildRows, headerModel, resolveSelection, scrollWindow, fold, formatMs } from '../src/view.js';

const ev = (o: Record<string, unknown>) => normalizeEvent({ runId: 'r1', ...o }) as VtoEvent;
const start = (extra: Record<string, unknown> = {}) => ev({ ev: 'run-start', kind: 'affected', total: 10, files: 2, pool: 'vm', ...extra });
const fail = (id: string, group: string, seq: number, extra: Record<string, unknown> = {}) =>
  ev({ ev: 'failure', seq, id, file: fileOfTestId(id), line: lineOfTestId(id), message: `Error ${group}`, group, frames: [{ file: 'src/a.ts', line: 3, col: 2, code: 'x()' }], ...extra });

describe('events', () => {
  it('parses the documented schema and ignores junk', () => {
    expect(parseLine('{"ev":"progress","runId":"r12","done":120,"failed":3,"etaMs":8400}')).toEqual({ ev: 'progress', runId: 'r12', done: 120, failed: 3, etaMs: 8400 });
    expect(parseLine('\uFEFF{"ev":"test","runId":"r","id":"a.test.ts:1 > x","state":"pass","ms":3}\r')).toMatchObject({ ev: 'test', state: 'pass' });
    expect(parseLine('not json')).toBeNull();
    expect(parseLine('{"ev":"unknown","runId":"r"}')).toBeNull();
    expect(parseLine('{"ev":"test","runId":"r","id":"x","state":"weird"}')).toBeNull();
    expect(parseLine('{"ev":"test","id":"x","state":"pass"}')).toBeNull(); // runId required
  });
  it('fills failure defaults from the test id', () => {
    const f = normalizeEvent({ ev: 'failure', runId: 'r', id: 'src/B.test.tsx:42 > B > x', seq: 1 });
    expect(f).toMatchObject({ file: 'src/B.test.tsx', line: 42, message: '(no message)', frames: [] });
  });
  it('splits NDJSON across chunks', () => {
    const s = new LineSplitter();
    expect(s.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(':2}\n')).toEqual(['{"b":2}']);
    expect(s.flush()).toEqual([]);
  });
  it('test id helpers', () => {
    expect(fileOfTestId('src/Button.test.tsx:42 > Button > disabled')).toBe('src/Button.test.tsx');
    expect(lineOfTestId('src/Button.test.tsx:42 > Button > disabled')).toBe(42);
    expect(nameOfTestId('src/Button.test.tsx:42 > Button > disabled')).toBe('Button > disabled');
    expect(fileOfTestId('C:/p/a.test.ts:7 > x')).toBe('C:/p/a.test.ts');
  });
});

describe('RunStore (event → state)', () => {
  it('counts tests per project, dedupes replays and handles retries', () => {
    const s = new RunStore();
    s.applyMany([
      start(),
      ev({ ev: 'file-start', file: 'a.test.tsx', project: 'dom' }),
      ev({ ev: 'file-start', file: 'b.test.ts', project: 'node' }),
      ev({ ev: 'test', id: 'a.test.tsx:1 > t1', state: 'pass' }),
      ev({ ev: 'test', id: 'a.test.tsx:1 > t1', state: 'pass' }), // replay duplicate
      ev({ ev: 'test', id: 'a.test.tsx:5 > t2', state: 'fail' }),
      ev({ ev: 'test', id: 'a.test.tsx:5 > t2', state: 'pass' }), // retry turned green
      ev({ ev: 'test', id: 'b.test.ts:1 > t3', state: 'skip' }),
    ]);
    const r = s.current!;
    expect([r.passed, r.failed, r.skipped]).toEqual([2, 0, 1]);
    expect(r.projects.get('dom')).toMatchObject({ done: 2, passed: 2, failed: 0, filesStarted: 1 });
    expect(r.projects.get('node')).toMatchObject({ done: 1, skipped: 1 });
    expect(r.filesStarted).toBe(2);
  });

  it('groups failures by `group`, append-only in order of first appearance', () => {
    const s = new RunStore();
    s.applyMany([start(), fail('a.test.ts:1 > x', 'g1', 1), fail('b.test.ts:1 > y', 'g2', 2), fail('c.test.ts:1 > z', 'g1', 3)]);
    const r = s.current!;
    expect(r.groupOrder).toEqual(['g1', 'g2']);
    expect(r.groups.get('g1')!.ids).toEqual(['a.test.ts:1 > x', 'c.test.ts:1 > z']);
    expect(r.failed).toBe(3); // failure without a `test` event still counts
  });

  it('a failure after its test(fail) event does not double count', () => {
    const s = new RunStore();
    s.applyMany([start(), ev({ ev: 'test', id: 'a.test.ts:1 > x', state: 'fail' }), fail('a.test.ts:1 > x', 'g1', 1)]);
    expect(s.current!.failed).toBe(1);
  });

  it('falls back to a normalised message hash when group is missing', () => {
    expect(fallbackGroupKey("expected 3 to be 4 'a'")).toBe(fallbackGroupKey("expected 5 to be 6 'b'"));
    expect(fallbackGroupKey('TypeError: x')).not.toBe(fallbackGroupKey('TypeError: y'));
    const s = new RunStore();
    s.applyMany([start(), fail('a.test.ts:1 > x', '', 1, { group: undefined, message: 'expected 1 to be 2' }), fail('a.test.ts:2 > y', '', 2, { group: undefined, message: 'expected 3 to be 4' })]);
    expect(s.current!.groupOrder.length).toBe(1);
  });

  it('fix-rerun marks failures fixed / still failing; markPending', () => {
    const s = new RunStore({ now: () => 5 });
    s.applyMany([start(), fail('a.test.ts:1 > x', 'g1', 1), fail('a.test.ts:2 > y', 'g1', 2)]);
    s.markPending('r1', ['a.test.ts:2 > y']);
    expect(s.current!.failures.get('a.test.ts:2 > y')!.fix).toBe('pending');
    s.applyMany([ev({ ev: 'fix-rerun', id: 'a.test.ts:1 > x', state: 'pass' }), ev({ ev: 'fix-rerun', id: 'a.test.ts:2 > y', state: 'fail' })]);
    const r = s.current!;
    expect(r.failures.get('a.test.ts:1 > x')).toMatchObject({ fix: 'fixed', fixedAt: 5 });
    expect(r.failures.get('a.test.ts:2 > y')!.fix).toBe('still-failing');
    s.apply(ev({ ev: 'fix-rerun', id: 'unknown', state: 'pass' })); // ignored
    expect(r.fixReruns).toBe(3);
  });

  it('rerun_failed runs (kind "failed") overlay the base run instead of replacing the view', () => {
    const s = new RunStore();
    s.applyMany([start(), fail('a.test.ts:1 > x', 'g1', 1), fail('a.test.ts:2 > y', 'g1', 2), fail('b.test.ts:1 > z', 'g2', 3)]);
    s.markPending('r1', ['a.test.ts:1 > x', 'a.test.ts:2 > y', 'b.test.ts:1 > z']);
    s.applyMany([
      ev({ ev: 'run-start', runId: 'r2', kind: 'failed', total: 3, files: 2 }),
      ev({ ev: 'file-start', runId: 'r2', file: 'a.test.ts', project: '' }),
      ev({ ev: 'test', runId: 'r2', id: 'a.test.ts:1 > x', state: 'pass' }),
      ev({ ev: 'test', runId: 'r2', id: 'a.test.ts:2 > y', state: 'fail' }),
      fail('a.test.ts:2 > y', 'g1', 1, { runId: 'r2', message: 'Error g1 (new text)' }),
      ev({ ev: 'run-end', runId: 'r2', passed: 1, failed: 1, skipped: 0, ms: 50 }),
    ]);
    expect(s.currentId).toBe('r1');
    const r = s.current!;
    expect(s.runs.get('r2')!.overlayOf).toBe('r1');
    expect(r.failures.get('a.test.ts:1 > x')!.fix).toBe('fixed');
    expect(r.failures.get('a.test.ts:2 > y')).toMatchObject({ fix: 'still-failing', message: 'Error g1 (new text)' });
    expect(r.failures.get('b.test.ts:1 > z')!.fix).toBe('none'); // requested, never reported → back to failed
    expect(r.groupOrder).toEqual(['g1', 'g2']); // positions unchanged
    expect(s.runs.get('r2')!.projects.has('default')).toBe(true); // project "" → default
    // a genuinely new run still takes over
    s.apply(ev({ ev: 'run-start', runId: 'r3', kind: 'affected', total: 5, files: 1 }));
    expect(s.currentId).toBe('r3');
  });

  it('follows the newest run unless pinned; notifies once per batch', () => {
    const s = new RunStore();
    let n = 0; s.subscribe(() => n++);
    s.applyMany([start(), ev({ ev: 'run-start', runId: 'r2', kind: 'tests', total: 1, files: 1 })]);
    expect(s.currentId).toBe('r2');
    expect(n).toBe(1);
    const p = new RunStore({ pinnedRunId: 'r1' });
    p.applyMany([start(), ev({ ev: 'run-start', runId: 'r2', kind: 'tests', total: 1, files: 1 })]);
    expect(p.currentId).toBe('r1');
  });

  it('header model: ETA from progress counts down, run-end is authoritative', () => {
    let now = 1000;
    const s = new RunStore({ now: () => now });
    s.applyMany([start({ projects: { dom: { total: 6, files: 1 }, node: { total: 4, files: 1 } } }), ev({ ev: 'progress', done: 4, failed: 1, etaMs: 3000 })]);
    now = 2000;
    let h = headerModel(s.current, now)!;
    expect(h.etaMs).toBe(2000);
    expect(h.done).toBe(4);
    expect(h.projects.map((p) => [p.name, p.total])).toEqual([['dom', 6], ['node', 4]]);
    s.apply(ev({ ev: 'run-end', passed: 8, failed: 2, skipped: 0, ms: 2100 }));
    h = headerModel(s.current, now)!;
    expect(h).toMatchObject({ ended: true, done: 10, passed: 8, failed: 2, elapsedMs: 2100, etaMs: undefined });
  });
});

describe('view selectors', () => {
  const setup = () => {
    const s = new RunStore();
    s.applyMany([start(), fail('a.test.ts:1 > alpha', 'g1', 1), fail('b.test.ts:1 > beta', 'g2', 2), fail('c.test.ts:1 > gamma', 'g1', 3, { message: 'Chyba: selhání' })]);
    return s;
  };
  it('one row per group, members when expanded (only for groups > 1)', () => {
    const s = setup();
    const f = { mode: 'all' as const, text: '' };
    expect(buildRows(s.current, f, new Set()).map((r) => r.key)).toEqual(['g:g1', 'g:g2']);
    expect(buildRows(s.current, f, new Set(['g1', 'g2'])).map((r) => r.key)).toEqual(['g:g1', 't:a.test.ts:1 > alpha', 't:c.test.ts:1 > gamma', 'g:g2']);
    expect(buildRows(s.current, f, new Set())[0]).toMatchObject({ count: 2, status: 'failed' });
  });
  it('filters by mode and diacritics-insensitive text', () => {
    const s = setup();
    s.apply(ev({ ev: 'fix-rerun', id: 'b.test.ts:1 > beta', state: 'pass' }));
    expect(buildRows(s.current, { mode: 'failed', text: '' }, new Set()).map((r) => r.key)).toEqual(['g:g1']);
    expect(buildRows(s.current, { mode: 'fixed', text: '' }, new Set()).map((r) => r.key)).toEqual(['g:g2']);
    const t = buildRows(s.current, { mode: 'all', text: 'SELHANI' }, new Set());
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ failureId: 'c.test.ts:1 > gamma', count: 1 });
    expect(fold('Žluťoučký kůň')).toBe('zlutoucky kun');
  });
  it('group status: partial / fixed / pending', () => {
    const s = setup();
    s.apply(ev({ ev: 'fix-rerun', id: 'a.test.ts:1 > alpha', state: 'pass' }));
    expect(buildRows(s.current, { mode: 'all', text: '' }, new Set())[0].status).toBe('partial');
    s.apply(ev({ ev: 'fix-rerun', id: 'c.test.ts:1 > gamma', state: 'pass' }));
    expect(buildRows(s.current, { mode: 'all', text: '' }, new Set())[0].status).toBe('fixed');
  });
  it('selection is by key: new rows arriving never move it', () => {
    const s = setup();
    const rows1 = buildRows(s.current, { mode: 'all', text: '' }, new Set());
    const key = rows1[1].key;
    s.applyMany([fail('d.test.ts:1 > delta', 'g3', 4), fail('e.test.ts:1 > eps', 'g1', 5)]);
    const rows2 = buildRows(s.current, { mode: 'all', text: '' }, new Set());
    expect(rows2[resolveSelection(rows2, key, 1)].key).toBe(key);
    expect(resolveSelection(rows2, key, 1)).toBe(1);
  });
  it('vanished selection falls back to the group row, then to the old index', () => {
    const s = setup();
    const collapsed = buildRows(s.current, { mode: 'all', text: '' }, new Set());
    expect(resolveSelection(collapsed, 't:a.test.ts:1 > alpha', 5)).toBe(0);
    expect(resolveSelection(collapsed, 'g:nope', 5)).toBe(1);
    expect(resolveSelection([], 'x', 3)).toBe(-1);
  });
  it('scroll window moves minimally', () => {
    expect(scrollWindow(0, 0, 5, 20)).toBe(0);
    expect(scrollWindow(6, 0, 5, 20)).toBe(2);
    expect(scrollWindow(3, 2, 5, 20)).toBe(2);
    expect(scrollWindow(1, 2, 5, 20)).toBe(1);
    expect(scrollWindow(19, 0, 5, 20)).toBe(15);
    expect(scrollWindow(2, 10, 5, 4)).toBe(0);
  });
  it('formats durations', () => {
    expect(formatMs(840)).toBe('840 ms');
    expect(formatMs(8400)).toBe('8.4 s');
    expect(formatMs(21400)).toBe('21 s');
    expect(formatMs(125000)).toBe('2 min 5 s');
  });
});
