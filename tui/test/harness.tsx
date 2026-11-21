// Test/capture harness: renders <App> into a fake terminal of a given size.
// ink-testing-library is fixed at 100 columns; this one is configurable and can also run Ink in
// its real interactive (TTY) code path for benchmarks.
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink';
import { App, type Actions, type AppProps } from '../src/ui/App.js';
import { RunStore } from '../src/model.js';
import type { EventSource } from '../src/sources/types.js';
import { patchInkOutputCaches } from '../src/ui/inkPerf.js';

// same Ink configuration as the CLI (kill switch VTO_UI_NO_INK_PATCH=1)
await patchInkOutputCaches();

export class FakeStdout extends EventEmitter {
  frames: string[] = [];
  bytes = 0;
  writes = 0;
  isTTY: boolean;
  constructor(public columns: number, public rows: number, tty = false) { super(); this.isTTY = tty; }
  write = (s: string) => { this.writes++; this.bytes += Buffer.byteLength(s); this.frames.push(s); if (this.frames.length > 50) this.frames.splice(0, this.frames.length - 50); return true; };
  lastFrame = () => this.frames.at(-1) ?? '';
  resize(columns: number, rows: number) { this.columns = columns; this.rows = rows; this.emit('resize'); }
  getWindowSize() { return [this.columns, this.rows]; }
  hasColors() { return true; }
}

export class FakeStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  write = (d: string) => { this.data = d; this.emit('readable'); this.emit('data', d); };
  read = () => { const d = this.data; this.data = null; return d; };
  setEncoding() {} setRawMode() {} resume() {} pause() {} ref() {} unref() {}
}

export const fakeActions = (log: string[] = []): Actions & { log: string[] } => ({
  log,
  async openEditor(t) { log.push(`open ${t.file}:${t.line}${t.col ? ':' + t.col : ''}`); return 'fake-editor'; },
  async copy(text) { log.push('copy ' + text.length); (fakeActions as any).lastCopied = text; return 'fake-clipboard'; },
});

export interface Rendered {
  stdout: FakeStdout;
  stdin: FakeStdin;
  lastFrame(): string;
  press(keys: string): Promise<void>;
  unmount(): void;
  waitFrame(): Promise<void>;
}

export const KEYS = { up: '\x1b[A', down: '\x1b[B', enter: '\r', esc: '\x1b', tab: '\t', pgdn: '\x1b[6~', pgup: '\x1b[5~' };

export function renderApp(opts: {
  store: RunStore; source: EventSource; root: string; actions?: Actions; columns?: number; rows?: number;
  interactive?: boolean; staticClock?: number; batchMs?: number; onRender?: (ms: number) => void; incremental?: boolean;
}): Rendered {
  const columns = opts.columns ?? 120, rows = opts.rows ?? 36;
  const stdout = new FakeStdout(columns, rows, !!opts.interactive);
  const stdin = new FakeStdin();
  const props: AppProps = {
    store: opts.store, source: opts.source, root: opts.root, actions: opts.actions ?? fakeActions(),
    staticClock: opts.staticClock, batchMs: opts.batchMs ?? 0,
  };
  const inst = render(<App {...props} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: new FakeStdout(columns, rows) as unknown as NodeJS.WriteStream,
    debug: !opts.interactive,
    interactive: !!opts.interactive,
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: opts.interactive ? 30 : 1000,
    incrementalRendering: opts.incremental ?? !!opts.interactive,
    onRender: opts.onRender ? ({ renderTime }) => opts.onRender!(renderTime) : undefined,
  });
  const tick = () => new Promise<void>((r) => setTimeout(r, 15));
  return {
    stdout, stdin,
    lastFrame: () => stdout.lastFrame(),
    async press(keys: string) { stdin.write(keys); await tick(); await tick(); },
    unmount: () => { inst.unmount(); inst.cleanup(); },
    waitFrame: async () => { await tick(); await tick(); },
  };
}
