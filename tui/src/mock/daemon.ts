// Mock daemon speaking the real vto-ipc/1 protocol (mcp/src/ipc.mjs): publishes endpoint.json
// (0600, in the per-user 0700 runtime dir), requires `hello {token}`, then `subscribe` (with
// replay of the active run), `rerun_failed`, `status`. Plays the TUI's fixture scenario, whose
// failures point at real files (code frames). mcp/dev/mock-events.mjs is the daemon team's mock;
// both are exercised by the tests.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { LineSplitter } from '../events.js';
import type { VtoEvent } from '../events.js';
import { PROTOCOL, endpointDir, type Endpoint } from '../sources/protocol.js';
import { MockSource, type MockSourceOptions } from './source.js';

export interface MockDaemon { endpoint: Endpoint; close(): Promise<void>; source: MockSource }

const safeEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

function privateDir(d: string) {
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(d, 0o700);
}

export async function startMockDaemon(o: MockSourceOptions & { projectRoot: string; writeRuns?: boolean }): Promise<MockDaemon> {
  const src = new MockSource(o);
  const token = randomBytes(32).toString('hex');
  const dir = endpointDir(o.projectRoot);
  privateDir(dir);
  let address = process.platform === 'win32' ? `\\\\.\\pipe\\vto-${randomBytes(16).toString('hex')}` : path.join(dir, 'd.sock');
  if (process.platform !== 'win32' && Buffer.byteLength(address) > 100) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-')); fs.chmodSync(tmp, 0o700); address = path.join(tmp, 'd.sock');
  }
  if (process.platform !== 'win32') { try { fs.unlinkSync(address); } catch {} }
  const history = new Map<string, string[]>(); // runId → lines (replay of the active run)
  let active: string | null = null;
  const subs = new Set<net.Socket>();
  const runsDir = path.join(o.projectRoot, '.vto', 'runs');
  const logs = new Map<string, fs.WriteStream>();
  const broadcast = (evs: VtoEvent[]) => {
    for (const e of evs) {
      if (e.ev === 'run-start') { active = e.runId; history.set(e.runId, []); }
      const line = JSON.stringify(e) + '\n';
      history.get(e.runId)?.push(line);
      if (o.writeRuns) {
        let w = logs.get(e.runId);
        if (!w) { fs.mkdirSync(runsDir, { recursive: true }); w = fs.createWriteStream(path.join(runsDir, `${e.runId}.jsonl`)); logs.set(e.runId, w); }
        w.write(line);
      }
      for (const s of subs) s.write(line);
    }
  };
  const server = net.createServer((sock) => {
    let authed = false;
    sock.setEncoding('utf8');
    const split = new LineSplitter();
    sock.on('error', () => subs.delete(sock));
    sock.on('close', () => subs.delete(sock));
    sock.on('data', async (chunk: string) => {
      for (const line of split.push(chunk)) {
        let m: { id?: number; method?: string; params?: any };
        try { m = JSON.parse(line); } catch { continue; }
        const reply = (body: object) => sock.write(JSON.stringify({ id: m.id, ...body }) + '\n');
        if (!authed) {
          if (m.method !== 'hello' || !safeEqual(String(m.params?.token ?? ''), token)) { reply({ error: { code: 'E_AUTH', message: 'authentication required' } }); sock.destroy(); return; }
          authed = true; reply({ result: { protocol: PROTOCOL, pid: process.pid, root: o.projectRoot } }); continue;
        }
        if (m.method === 'subscribe') {
          reply({ result: { subscribed: m.params?.topics ?? 'all', activeRun: active } });
          if (m.params?.replay !== false && active) for (const l of history.get(active) ?? []) sock.write(l);
          subs.add(sock);
        } else if (m.method === 'status') reply({ result: { v: 'vto/1', mock: true, activeRun: active } });
        else {
          try { reply({ result: await src.request({ method: m.method, params: m.params } as never) }); }
          catch (e) { reply({ error: { code: (e as { code?: string }).code ?? 'E_INTERNAL', message: (e as Error).message } }); }
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(address, () => resolve()); });
  if (process.platform !== 'win32') { try { fs.chmodSync(address, 0o600); } catch {} }
  const endpoint: Endpoint = { protocol: PROTOCOL, pid: process.pid, address, token, root: o.projectRoot.replace(/\\/g, '/'), startedAt: new Date().toISOString() };
  const epFile = path.join(dir, 'endpoint.json');
  fs.writeFileSync(epFile + '.tmp', JSON.stringify(endpoint), { mode: 0o600 });
  fs.renameSync(epFile + '.tmp', epFile);
  src.start({ onEvents: broadcast });
  return {
    endpoint, source: src,
    close: () => new Promise<void>((r) => {
      src.close();
      for (const s of subs) s.destroy();
      for (const w of logs.values()) w.end();
      try { fs.unlinkSync(epFile); } catch {}
      server.close(() => r());
    }),
  };
}
