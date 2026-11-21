// Read `.vto/runs/<runId>.jsonl` and optionally keep following it (tail -f). fs.watch gives low
// latency where it works; a stat poll covers network drives / WSL mounts where it does not.
// Handles partial trailing lines and truncation/rotation (restart from 0).
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { LineSplitter, parseLine, type VtoEvent } from '../events.js';
import { ReadOnlyError, type EventSource, type SourceHandlers } from './types.js';

export interface FileSourceOptions { follow?: boolean; pollMs?: number; /** stop following after run-end */ stopAtEnd?: boolean }

export class FileSource implements EventSource {
  readonly canRequest = false;
  readonly label: string;
  private offset = 0;
  private split = new LineSplitter();
  private dec = new StringDecoder('utf8');
  private watcher: fs.FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private reading = false;
  private again = false;
  private closed = false;
  private h: SourceHandlers | null = null;
  private ino = -1;

  constructor(private file: string, private o: FileSourceOptions = {}) { this.label = `soubor ${file}`; }

  start(h: SourceHandlers): void {
    this.h = h;
    h.onStatus?.('live');
    this.read();
    if (this.o.follow === false) return;
    try { this.watcher = fs.watch(this.file, () => this.read()); this.watcher.on('error', () => {}); } catch { /* poll only */ }
    this.timer = setInterval(() => this.read(), this.o.pollMs ?? 250);
  }

  private read() {
    if (this.closed) return;
    if (this.reading) { this.again = true; return; }
    this.reading = true;
    try {
      let st: fs.Stats;
      try { st = fs.statSync(this.file); } catch { return; }
      if (st.ino !== this.ino || st.size < this.offset) { // rotated or truncated
        if (this.ino !== -1) { this.offset = 0; this.split = new LineSplitter(); this.dec = new StringDecoder('utf8'); }
        this.ino = st.ino;
      }
      if (st.size === this.offset) return;
      const fd = fs.openSync(this.file, 'r');
      const evs: VtoEvent[] = [];
      try {
        const buf = Buffer.allocUnsafe(1 << 20);
        let ended = false;
        while (this.offset < st.size) {
          const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - this.offset), this.offset);
          if (n <= 0) break;
          this.offset += n;
          // StringDecoder keeps multi-byte UTF-8 sequences split across reads intact
          for (const line of this.split.push(this.dec.write(buf.subarray(0, n)))) {
            const ev = parseLine(line);
            if (ev) { evs.push(ev); if (ev.ev === 'run-end') ended = true; }
          }
        }
        if (this.o.follow === false) for (const line of this.split.flush()) { const ev = parseLine(line); if (ev) evs.push(ev); }
        if (evs.length) this.h?.onEvents(evs);
        if (this.o.follow === false || (ended && this.o.stopAtEnd)) { this.stopWatching(); this.h?.onStatus?.('ended'); }
      } finally { fs.closeSync(fd); }
    } finally {
      this.reading = false;
      if (this.again) { this.again = false; setImmediate(() => this.read()); }
    }
  }

  private stopWatching() {
    this.watcher?.close(); this.watcher = null;
    if (this.timer) clearInterval(this.timer); this.timer = null;
  }

  request(): Promise<unknown> { return Promise.reject(new ReadOnlyError()); }
  close(): void { this.closed = true; this.stopWatching(); }
}
