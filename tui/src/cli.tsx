#!/usr/bin/env node
// vto ui – entry point: pick the event source, pick TUI vs plain (CI) mode, run.
import fs from 'node:fs';
import path from 'node:path';
import tty from 'node:tty';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { render } from 'ink';
import { App } from './ui/App.js';
import { RunStore } from './model.js';
import { CiPrinter } from './ci.js';
import { detectColorLevel, detectUnicode, initTerm, prefersFullRedraw } from './term.js';
import { detectLocale, setLocale } from './i18n.js';
import { realActions } from './actions.js';
import { IpcSource } from './sources/ipc.js';
import { FileSource } from './sources/file.js';
import { StreamSource } from './sources/stream.js';
import { PROTOCOL, endpointDir, findRoot, latestRunFile, type Endpoint } from './sources/protocol.js';
import type { EventSource, SourceStatus } from './sources/types.js';
import { MockSource } from './mock/source.js';
import { DEFAULT_MOCK, buildScenario } from './mock/scenario.js';
import { startMockDaemon } from './mock/daemon.js';
import { patchInkOutputCaches } from './ui/inkPerf.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ROOT = path.resolve(HERE, '..', 'dev', 'fixture');

interface Args { [k: string]: string | boolean | undefined }

const BOOL = new Set(['mock', 'mock-daemon', 'stdin', 'latest', 'ci', 'plain', 'ascii', 'no-color', 'no-follow', 'help', 'h', 'version', 'V', 'tui', 'mock-no-project-totals', 'wait', 'write-runs']);

export function parseArgs(argv: string[]): Args {
  const a: Args = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith('--') || (x.startsWith('-') && x.length === 2)) {
      const [k, v] = x.replace(/^--?/, '').split(/=(.*)/s, 2);
      if (v !== undefined) a[k] = v;
      else if (BOOL.has(k)) a[k] = true;
      else a[k] = argv[++i];
    } else rest.push(x);
  }
  if (rest[0] === 'ui' || rest[0] === 'watch') rest.shift();
  if (rest[0] === 'mock-daemon') a['mock-daemon'] = true;
  return a;
}

const HELP = `vto ui – live test failures in the terminal

Usage:  vto ui [options]        (same as: vto-ui [ui|watch] [options])

Event source (default: daemon → newest .vto/runs/*.jsonl → stdin):
  (daemon)                found via <runtime dir>/<project key>/endpoint.json of --root
  --wait                  wait for the daemon (and its next run) instead of giving up
  --socket <address>      explicit socket / named pipe; token from VTO_TOKEN
  --file <run.jsonl>      read a run log; follows it (tail -f) unless --no-follow
  --latest                follow the newest .vto/runs/<runId>.jsonl
  --stdin                 NDJSON events on stdin
  --mock                  built-in mock run (fixture in dev/fixture)
     --mock-tests N --mock-failures N --mock-files N --mock-duration MS
     --mock-speed X --mock-seed N --mock-fix N --mock-no-project-totals
     --write <file.jsonl>  also write the mock events to a file
  mock-daemon             start a mock daemon for --root (vto-ipc/1, endpoint.json; no UI)
     --write-runs          also write .vto/runs/<runId>.jsonl under --root

Other:
  --root <dir>            project root (default: nearest dir with .vto/ or package.json)
  --run <runId>           stay on this run (default: follow the newest run)
  --ci, --plain           plain streaming output (automatic when stdout is not a TTY or CI is set)
  --ascii                 ASCII glyphs/borders (also VTO_ASCII=1)
  --no-color              no colours (also NO_COLOR=1; FORCE_COLOR=0..3 overrides)
  --lang en|cs            UI language (default en; also VTO_LANG)
  --version, -V           print the version
  --help, -h              this help

Keys: ? help · o/O open the project file in your editor (VTO_EDITOR > VISUAL > EDITOR > code/vim…;
      never the OS default handler – without an editor the path is shown and copied)
      c copy an AI prompt · a queue for an agent · r/R rerun · f filter · / search · q quit
Exit codes (--ci): 0 run ended green · 1 failures remain · 2 usage error or incomplete run
`;

function readVersion(): string {
  try { return String(JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8')).version); } catch { return 'unknown'; }
}

function mockOptions(a: Args, root: string) {
  const n = (k: string, d: number) => (a[k] !== undefined ? Number(a[k]) : d);
  return {
    ...DEFAULT_MOCK,
    root,
    tests: n('mock-tests', DEFAULT_MOCK.tests),
    failures: n('mock-failures', DEFAULT_MOCK.failures),
    files: n('mock-files', a['mock-tests'] ? Math.max(6, Math.round(n('mock-tests', 412) / 11)) : DEFAULT_MOCK.files),
    durationMs: n('mock-duration', DEFAULT_MOCK.durationMs),
    seed: n('mock-seed', DEFAULT_MOCK.seed),
    fixDuringRun: n('mock-fix', DEFAULT_MOCK.fixDuringRun),
    projectTotals: !a['mock-no-project-totals'],
    speed: n('mock-speed', 1),
  };
}

function openTtyInput(): tty.ReadStream | null {
  try {
    const fd = fs.openSync(process.platform === 'win32' ? 'CONIN$' : '/dev/tty', 'r');
    return new tty.ReadStream(fd);
  } catch { return null; }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const a = parseArgs(argv);
  if (a.help || a.h) { process.stdout.write(HELP); return 0; }
  if (a.version || a.V) { process.stdout.write(`vto-ui ${readVersion()}\n`); return 0; }
  const env = process.env;
  if (a.lang) env.VTO_LANG = String(a.lang);
  setLocale(detectLocale(env));
  if (a.ascii) env.VTO_ASCII = '1';
  if (a['no-color']) env.NO_COLOR = '1';

  const plain = Boolean(a.ci || a.plain || !process.stdout.isTTY || (env.CI && env.CI !== 'false' && env.CI !== '0'));
  initTerm({ colorLevel: detectColorLevel(env, Boolean(process.stdout.isTTY) || 'FORCE_COLOR' in env), unicode: detectUnicode(env), sgr: env.TERM !== 'dumb' });

  const root = a.root ? path.resolve(String(a.root)) : a.mock || a['mock-daemon'] ? FIXTURE_ROOT : findRoot(process.cwd());
  const explicit: Endpoint | undefined = a.socket
    ? { protocol: PROTOCOL, pid: 0, address: String(a.socket), token: env.VTO_TOKEN ?? '', root }
    : undefined;

  if (a['mock-daemon']) {
    const d = await startMockDaemon({ ...mockOptions(a, root), projectRoot: root, writeRuns: Boolean(a['write-runs']) });
    process.stderr.write(`mock daemon for ${root}\n  endpoint ${d.endpoint.address}\n  discovery ${endpointDir(root)}/endpoint.json\n  Ctrl+C to stop\n`);
    await new Promise<void>((r) => { process.once('SIGINT', r); process.once('SIGTERM', r); });
    await d.close();
    return 0;
  }

  // ---------------------------------------------------------------- source
  let source: EventSource;
  let stdinIsEvents = false;
  if (a.mock) {
    const mo = mockOptions(a, root);
    if (a.write) {
      const f = String(a.write);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, buildScenario(mo).map((x) => JSON.stringify(x.ev)).join('\n') + '\n');
    }
    source = new MockSource(mo);
  } else if (a.file || a.latest) {
    const f = a.file ? path.resolve(String(a.file)) : latestRunFile(root);
    if (!f) { process.stderr.write(`vto ui: no .vto/runs/*.jsonl under ${root}\n`); return 2; }
    source = new FileSource(f, { follow: !a['no-follow'], stopAtEnd: plain });
  } else if (a.stdin) {
    source = new StreamSource(process.stdin); stdinIsEvents = true;
  } else if (explicit || a.wait || (await IpcSource.probe(root))) {
    source = new IpcSource({ root, endpoint: explicit, reconnect: !plain || Boolean(a.wait) });
  } else {
    const f = latestRunFile(root);
    if (f) source = new FileSource(f, { follow: true, stopAtEnd: plain });
    else if (!process.stdin.isTTY) {
      process.stderr.write(`vto ui: no daemon for ${root} and no .vto/runs/*.jsonl – reading NDJSON events from stdin (start a daemon, or use --wait / --file)\n`);
      source = new StreamSource(process.stdin); stdinIsEvents = true;
    }
    else {
      process.stderr.write(`vto ui: no daemon for ${root} (${endpointDir(root)}/endpoint.json) and no .vto/runs/*.jsonl.\n` +
        `       Start one (vto daemon start, i.e. node <vto>/mcp/bin/vto-daemon.mjs serve --root <dir>; or any vto MCP call),\n       use --wait, or try the mock: vto ui --mock\n`);
      return 2;
    }
  }

  // ---------------------------------------------------------------- plain / CI
  if (plain) {
    // `vto-ui --ci | head` – the reader went away: stop quietly
    process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') { source.close(); process.exit(0); } });
    const ci = new CiPrinter({ write: (s) => process.stdout.write(s), runId: a.run ? String(a.run) : undefined });
    return await new Promise<number>((resolve) => {
      const finish = () => { source.close(); resolve(ci.exitCode); };
      source.start({
        onEvents: (evs) => { ci.onEvents(evs); if (ci.done) finish(); },
        onStatus: (st, detail) => {
          if (st === 'ended' || st === 'error') {
            if (st === 'error') process.stderr.write(`vto ui: ${detail ?? 'source error'}\n`);
            ci.sourceEnded(); finish();
          }
        },
      });
      if (source instanceof MockSource) { /* timers keep the process alive */ }
    });
  }

  // ---------------------------------------------------------------- TUI
  const store = new RunStore({ pinnedRunId: a.run ? String(a.run) : undefined });
  let status: SourceStatus | string = 'connecting';
  const stdin = stdinIsEvents ? openTtyInput() : process.stdin;
  if (!stdin) { process.stderr.write('vto ui: no terminal for keyboard input; use --file or --ci\n'); return 2; }
  await patchInkOutputCaches(env);
  const perf = env.VTO_UI_PERF === '1';
  const renderTimes: number[] = [];
  const actions = realActions(root, { hasTTY: true, writeTerminal: (s) => process.stdout.write(s) });
  source.start({ onEvents: (evs) => store.applyMany(evs), onStatus: (st) => { status = st; } });
  const inst = render(
    <App store={store} source={source} root={root} actions={actions} sourceStatus={() => String(status)} />,
    {
      stdin: stdin as NodeJS.ReadStream,
      alternateScreen: true,
      // see prefersFullRedraw(): full redraw where synchronized output is known to work,
      // otherwise only changed lines are rewritten (no flicker on Terminal.app / conhost)
      incrementalRendering: !prefersFullRedraw(env),
      maxFps: 30,
      exitOnCtrlC: false,
      patchConsole: true,
      onRender: perf ? ({ renderTime }) => { renderTimes.push(renderTime); } : undefined,
    },
  );
  await inst.waitUntilExit();
  source.close();
  if (perf && renderTimes.length) {
    const sorted = [...renderTimes].sort((x, y) => x - y);
    const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(2);
    process.stderr.write(`vto ui perf: ${renderTimes.length} frames, render p50 ${p(0.5)} ms, p95 ${p(0.95)} ms, max ${p(1)} ms, rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB, events ${store.eventsApplied}\n`);
  }
  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (isMain) {
  main().then((code) => process.exit(code), (e) => { process.stderr.write(`vto ui: ${(e as Error).stack ?? e}\n`); process.exit(2); });
}
