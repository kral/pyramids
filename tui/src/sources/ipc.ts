// Daemon subscription over vto-ipc/1 (see protocol.ts): discover endpoint.json → connect →
// hello{token} → subscribe{topics, replay}. Reconnects with backoff, re-reading endpoint.json
// (a restarted daemon has a new address and token); the store dedupes replayed events.
import net from 'node:net';
import { LineSplitter, type VtoEvent } from '../events.js';
import { PROTOCOL, decodeMessage, encodeRequest, readEndpoint, type Endpoint } from './protocol.js';
import type { DaemonRequest, EventSource, SourceHandlers } from './types.js';

export interface IpcOptions {
  /** project root → endpoint.json discovery */
  root?: string;
  /** explicit endpoint (tests, --socket + VTO_TOKEN) */
  endpoint?: Endpoint;
  reconnect?: boolean;
  /** subscribe topics; coverage is not needed by the UI (it is the chattiest topic) */
  topics?: string[];
  client?: string;
}

export class DaemonError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

export class IpcSource implements EventSource {
  readonly canRequest = true;
  label: string;
  private sock: net.Socket | null = null;
  private h: SourceHandlers | null = null;
  private seq = 0;
  private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closed = false;
  private backoff = 200;
  private ready = false;
  private everConnected = false;

  constructor(private o: IpcOptions) { this.label = o.endpoint ? `daemon ${o.endpoint.address}` : `daemon (${o.root})`; }

  /** Is a daemon for `root` reachable (endpoint.json present, pid alive, socket accepts)? */
  static async probe(root: string, timeoutMs = 400): Promise<Endpoint | null> {
    const ep = readEndpoint(root);
    if (!ep) return null;
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect(ep.address);
      const t = setTimeout(() => { s.destroy(); resolve(false); }, timeoutMs);
      s.once('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
      s.once('error', () => { clearTimeout(t); resolve(false); });
    });
    return ok ? ep : null;
  }

  start(h: SourceHandlers): void { this.h = h; this.connect(); }

  private retry(detail: string) {
    if (this.closed) return;
    if (this.o.reconnect === false) { this.h?.onStatus?.(this.everConnected ? 'ended' : 'error', detail); return; }
    this.h?.onStatus?.('reconnecting', detail);
    setTimeout(() => this.connect(), this.backoff).unref();
    this.backoff = Math.min(this.backoff * 2, 5000);
  }

  private connect() {
    if (this.closed) return;
    const ep = this.o.endpoint ?? (this.o.root ? readEndpoint(this.o.root) : null);
    if (!ep) { this.retry('daemon not running'); return; }
    this.label = `daemon ${ep.address}`;
    this.h?.onStatus?.(this.everConnected ? 'reconnecting' : 'connecting');
    const sock = net.connect(ep.address);
    this.sock = sock;
    this.ready = false;
    sock.setEncoding('utf8');
    const split = new LineSplitter();
    sock.on('connect', () => {
      this.call('hello', { token: ep.token, protocol: PROTOCOL, client: this.o.client ?? 'vto-ui' }, true)
        .then(() => this.call('subscribe', { topics: this.o.topics ?? ['run', 'test'], replay: true }, true))
        .then(() => { this.ready = true; this.everConnected = true; this.backoff = 200; this.h?.onStatus?.('live'); })
        .catch((e: Error) => { this.h?.onStatus?.('error', e.message); sock.destroy(); });
    });
    sock.on('data', (chunk: string) => {
      const evs: VtoEvent[] = [];
      for (const line of split.push(chunk)) {
        const d = decodeMessage(line);
        if (d.type === 'event') evs.push(d.ev);
        else if (d.type === 'response') {
          const p = this.pending.get(d.id);
          if (p) { this.pending.delete(d.id); d.error ? p.reject(new DaemonError(d.error.message, d.error.code)) : p.resolve(d.result); }
        }
      }
      if (evs.length) this.h?.onEvents(evs);
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      this.sock = null;
      this.ready = false;
      for (const p of this.pending.values()) p.reject(new Error('connection closed'));
      this.pending.clear();
      this.retry('connection closed');
    });
  }

  private call(method: string, params: unknown, handshake = false): Promise<unknown> {
    const s = this.sock;
    if (!s || !s.writable || (!handshake && !this.ready)) return Promise.reject(new Error('not connected'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout')); }, 10_000);
      timer.unref();
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      s.write(encodeRequest(id, method, params));
    });
  }

  request(req: DaemonRequest): Promise<unknown> { return this.call(req.method, req.params); }

  close(): void { this.closed = true; this.sock?.end(); this.sock?.destroy(); }
}
