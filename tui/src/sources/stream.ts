// NDJSON from any readable stream (stdin: `vto run --json | vto-ui --stdin`).
import { StringDecoder } from 'node:string_decoder';
import { LineSplitter, parseLine, type VtoEvent } from '../events.js';
import { ReadOnlyError, type EventSource, type SourceHandlers } from './types.js';

export class StreamSource implements EventSource {
  readonly canRequest = false;
  constructor(private stream: NodeJS.ReadableStream, readonly label = 'stdin') {}
  start(h: SourceHandlers): void {
    const split = new LineSplitter();
    const dec = new StringDecoder('utf8');
    h.onStatus?.('live');
    const handle = (lines: string[]) => {
      const evs: VtoEvent[] = [];
      for (const l of lines) { const ev = parseLine(l); if (ev) evs.push(ev); }
      if (evs.length) h.onEvents(evs);
    };
    this.stream.on('data', (chunk: Buffer | string) => handle(split.push(typeof chunk === 'string' ? chunk : dec.write(chunk))));
    this.stream.on('end', () => { handle(split.push(dec.end())); handle(split.flush()); h.onStatus?.('ended'); });
    this.stream.on('error', (e: Error) => h.onStatus?.('error', e.message));
  }
  request(): Promise<unknown> { return Promise.reject(new ReadOnlyError()); }
  close(): void { (this.stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.(); }
}
