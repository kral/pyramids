import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { FileSource } from '../src/sources/file.js';
import { StreamSource } from '../src/sources/stream.js';
import { IpcSource } from '../src/sources/ipc.js';
import { decodeMessage, endpointDir } from '../src/sources/protocol.js';
import { startMockDaemon } from '../src/mock/daemon.js';
import { DEFAULT_MOCK, buildScenario } from '../src/mock/scenario.js';
import { CiPrinter } from '../src/ci.js';
import { initTerm } from '../src/term.js';
import { setLocale } from '../src/i18n.js';
import type { VtoEvent } from '../src/events.js';

const ROOT = path.resolve(__dirname, '../dev/fixture');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await wait(10); } }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vto-ui-'));

beforeAll(() => { initTerm({ colorLevel: 0, unicode: true, sgr: false }); setLocale('cs'); });

describe('protocol', () => {
  it('accepts bare events, event notifications and JSON-RPC responses', () => {
    expect(decodeMessage('{"ev":"progress","runId":"r","done":1,"failed":0}')).toMatchObject({ type: 'event' });
    expect(decodeMessage('{"jsonrpc":"2.0","method":"event","params":{"ev":"progress","runId":"r","done":1,"failed":0}}')).toMatchObject({ type: 'event' });
    expect(decodeMessage('{"jsonrpc":"2.0","id":3,"result":{"ok":true}}')).toEqual({ type: 'response', id: 3, result: { ok: true }, error: undefined });
    expect(decodeMessage('{"id":3,"error":{"code":"E_METHOD","message":"nope"}}')).toMatchObject({ type: 'response', error: { message: 'nope', code: 'E_METHOD' } });
    expect(decodeMessage('garbage')).toEqual({ type: 'ignored' });
  });
});

describe('FileSource (tail -f of .vto/runs/<runId>.jsonl)', () => {
  it('reads existing lines, follows appends incl. partial lines and multi-byte splits, survives truncation', async () => {
    const dir = tmp();
    const f = path.join(dir, 'r1.jsonl');
    fs.writeFileSync(f, '{"ev":"run-start","runId":"r1","kind":"full","total":2,"files":1}\n{"ev":"test","runId":"r1","id":"a > x","sta');
    const got: VtoEvent[] = [];
    const src = new FileSource(f, { pollMs: 20 });
    src.start({ onEvents: (e) => got.push(...e) });
    expect(got.map((e) => e.ev)).toEqual(['run-start']);
    fs.appendFileSync(f, 'te":"pass"}\n');
    await until(() => got.length === 2);
    // split a UTF-8 sequence ("č" = c4 8d) across two writes
    const line = Buffer.from('{"ev":"failure","runId":"r1","seq":1,"id":"a > č","file":"a","line":1,"message":"Kč"}\n');
    const cut = line.indexOf(0x8d);
    fs.appendFileSync(f, line.subarray(0, cut));
    await wait(60);
    fs.appendFileSync(f, line.subarray(cut));
    await until(() => got.length === 3);
    expect((got[2] as any).message).toBe('Kč');
    fs.writeFileSync(f, '{"ev":"run-start","runId":"r2","kind":"full","total":1,"files":1}\n'); // truncated / rotated
    await until(() => got.some((e) => e.runId === 'r2'));
    src.close();
  });
  it('--no-follow reads once and ends', () => {
    const dir = tmp();
    const f = path.join(dir, 'r.jsonl');
    fs.writeFileSync(f, buildScenario({ ...DEFAULT_MOCK, root: ROOT }).map((x) => JSON.stringify(x.ev)).join('\n'));
    const got: VtoEvent[] = []; let status = '';
    new FileSource(f, { follow: false }).start({ onEvents: (e) => got.push(...e), onStatus: (s) => { status = s; } });
    expect(got.at(-1)!.ev).toBe('run-end');
    expect(status).toBe('ended');
  });
});

describe('StreamSource (stdin)', () => {
  it('decodes NDJSON chunks and reports end', async () => {
    const pt = new PassThrough();
    const got: VtoEvent[] = []; let ended = false;
    new StreamSource(pt).start({ onEvents: (e) => got.push(...e), onStatus: (s) => { if (s === 'ended') ended = true; } });
    pt.write('{"ev":"run-start","runId":"r","kind":"full","total":1,"files":1}\n{"ev":"run-end","runId":"r",');
    pt.end('"passed":1,"failed":0,"skipped":0,"ms":5}');
    await until(() => ended);
    expect(got.map((e) => e.ev)).toEqual(['run-start', 'run-end']);
  });
});

describe('IpcSource ↔ mock daemon (vto-ipc/1: endpoint.json, hello token, subscribe)', () => {
  it('discovers the daemon, authenticates, replays the active run, round-trips rerun_failed', async () => {
    const rt = tmp(); fs.chmodSync(rt, 0o700);
    process.env.XDG_RUNTIME_DIR = rt; // isolate discovery from any real daemon
    const projectRoot = tmp();
    const d = await startMockDaemon({ ...DEFAULT_MOCK, root: ROOT, projectRoot, durationMs: 400, speed: 1, writeRuns: true });
    try {
      await wait(150); // part of the run already happened → must be replayed
      const ep = await IpcSource.probe(projectRoot);
      expect(ep?.address).toBe(d.endpoint.address);
      if (process.platform !== 'win32') expect(fs.statSync(path.join(endpointDir(projectRoot), 'endpoint.json')).mode & 0o777).toBe(0o600);
      const got: VtoEvent[] = [];
      const statuses: string[] = [];
      const src = new IpcSource({ root: projectRoot, reconnect: false });
      src.start({ onEvents: (e) => got.push(...e), onStatus: (st) => statuses.push(st) });
      await until(() => got.some((e) => e.ev === 'run-end'));
      expect(statuses).toContain('live');
      expect(got[0].ev).toBe('run-start');
      const fails = got.filter((e) => e.ev === 'failure');
      expect(fails.length).toBe(7);
      const res = await src.request({ method: 'rerun_failed', params: { runId: 'r12', ids: [(fails[1] as any).id] } }) as any;
      expect(res).toMatchObject({ runId: 'r13', total: 1, status: 'queued' });
      await until(() => got.some((e) => e.ev === 'run-end' && e.runId === 'r13'));
      expect(got.find((e) => e.ev === 'run-start' && e.runId === 'r13')).toMatchObject({ kind: 'failed', total: 1 });
      await expect(src.request({ method: 'enqueue_task', params: { task: {} } } as any)).resolves.toBeTruthy();
      await expect(src.request({ method: 'nope' as any, params: {} as any })).rejects.toMatchObject({ code: 'E_METHOD' });
      src.close();
      expect(fs.readFileSync(path.join(projectRoot, '.vto', 'runs', 'r12.jsonl'), 'utf8').split('\n').length).toBeGreaterThan(400);
    } finally { await d.close(); }
  });
  it('a wrong token is rejected; no endpoint → not running', async () => {
    const rt = tmp(); fs.chmodSync(rt, 0o700);
    process.env.XDG_RUNTIME_DIR = rt;
    const projectRoot = tmp();
    expect(await IpcSource.probe(projectRoot)).toBeNull();
    const d = await startMockDaemon({ ...DEFAULT_MOCK, root: ROOT, projectRoot, durationMs: 200 });
    try {
      const statuses: Array<[string, string | undefined]> = [];
      const src = new IpcSource({ endpoint: { ...d.endpoint, token: 'x'.repeat(64) }, reconnect: false });
      src.start({ onEvents: () => {}, onStatus: (st, detail) => statuses.push([st, detail]) });
      await until(() => statuses.some(([st]) => st === 'error'));
      expect(statuses.find(([st]) => st === 'error')![1]).toMatch(/authentication/);
      src.close();
    } finally { await d.close(); }
  });
});

describe('CI printer', () => {
  const run = (evs: Record<string, unknown>[]) => {
    let out = '';
    let t = 0;
    const ci = new CiPrinter({ write: (s) => { out += s; }, now: () => (t += 1000), progressIntervalMs: 60_000 });
    ci.onEvents(evs.map((e) => e as any as VtoEvent).map((e) => ({ ...e })) as VtoEvent[]);
    return { out, ci };
  };
  it('prints failures immediately, groups repeats, summary + exit code', () => {
    const evs = buildScenario({ ...DEFAULT_MOCK, root: ROOT }).map((x) => x.ev);
    let out = '';
    const ci = new CiPrinter({ write: (s) => { out += s; }, progressIntervalMs: 0 });
    const lines: number[] = [];
    for (const e of evs) { // feed one by one: output must grow at each failure
      const before = out.length;
      ci.onEvents([(e as any)]);
      if (e.ev === 'failure') lines.push(out.length - before);
    }
    expect(lines.every((n) => n > 0)).toBe(true);
    expect(out).toContain('opraveno během běhu: formatPrice > formats thousands');
    expect(out).toContain('stejná chyba v 2 testech');
    expect(out).toMatch(/Souhrn: 400 prošlo, 7 selhalo, 5 přeskočeno/);
    expect(out).toContain('6 selhání zbývá');
    expect(ci.exitCode).toBe(1);
    expect(out).toMatchSnapshot();
  });
  it('exit 0 when everything failing was fixed during the run; 2 without run-end', () => {
    const a = run([
      { ev: 'run-start', runId: 'r', kind: 'tests', total: 1, files: 1 },
      { ev: 'failure', runId: 'r', seq: 1, id: 'a.test.ts:1 > x', file: 'a.test.ts', line: 1, message: 'boom' },
      { ev: 'fix-rerun', runId: 'r', id: 'a.test.ts:1 > x', state: 'pass' },
      { ev: 'run-end', runId: 'r', passed: 0, failed: 1, skipped: 0, ms: 10 },
    ].map((e) => ({ ...e })) as any);
    expect(a.ci.exitCode).toBe(0);
    const b = run([{ ev: 'run-start', runId: 'r', kind: 'tests', total: 1, files: 1 }] as any);
    b.ci.sourceEnded();
    expect(b.ci.exitCode).toBe(2);
    expect(b.ci.done).toBe(true);
  });
});
