// Scripted end-to-end runs of the real CLI against the mock (CI mode, file, stdin, IPC daemon,
// and the interactive TUI inside a real pseudo-terminal).
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TUI = path.resolve(__dirname, '..');
const CLI = path.join(TUI, 'src', 'cli.tsx');
const TSX = path.join(TUI, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const env = { ...process.env, VTO_LANG: 'cs', NO_COLOR: '1', FORCE_COLOR: undefined, CI: undefined, LANG: 'C.UTF-8', TERM: 'xterm-256color' } as NodeJS.ProcessEnv;
delete env.FORCE_COLOR; delete env.CI;

function runCli(args: string[], input?: string, e: NodeJS.ProcessEnv = env): Promise<{ code: number; out: string; firstFailureAt: number; endAt: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [TSX, CLI, ...args], { cwd: TUI, env: e, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', firstFailureAt = -1;
    p.stdout.on('data', (d) => { out += d; if (firstFailureAt < 0 && /^[x✗] src\//m.test(out)) firstFailureAt = Date.now() - t0; });
    p.stderr.on('data', (d) => { err += d; });
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
    p.on('exit', (code) => resolve({ code: code ?? -1, out: out + err, firstFailureAt, endAt: Date.now() - t0 }));
  });
}

describe('e2e: plain / CI mode', () => {
  it('streams failures immediately while the mock run continues, summary at the end, exit 1', async () => {
    const r = await runCli(['--mock', '--ci', '--mock-duration', '4000']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('vto: běh r12 (dotčené, 412 testů, 38 souborů, pool vmThreads)');
    expect(r.out).toMatch(/Souhrn: 400 prošlo, 7 selhalo, 5 přeskočeno/);
    expect(r.out).toContain('1 opraveno během běhu');
    // the first failure was printed long before the run ended (not buffered until the end)
    expect(r.firstFailureAt).toBeGreaterThan(0);
    expect(r.endAt - r.firstFailureAt).toBeGreaterThan(1500);
  }, 30_000);

  it('reads a .vto/runs/<runId>.jsonl file (--file --no-follow) and stdin', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-e2e-'));
    const f = path.join(dir, '.vto', 'runs', 'r12.jsonl');
    const w = await runCli(['--mock', '--ci', '--mock-speed', '100', '--write', f]);
    expect(w.code).toBe(1);
    const a = await runCli(['--file', f, '--no-follow', '--ci']);
    expect(a.code).toBe(1);
    expect(a.out).toMatch(/Souhrn: 400 prošlo, 7 selhalo/);
    const b = await runCli(['--stdin', '--ci'], fs.readFileSync(f, 'utf8'));
    expect(b.code).toBe(1);
    expect(b.out).toMatch(/Souhrn: 400 prošlo, 7 selhalo/);
    // --latest + root discovery
    const c = await runCli(['--latest', '--ci', '--root', dir]);
    expect(c.code).toBe(1);
    // truncated log → exit 2 (no run-end)
    const half = fs.readFileSync(f, 'utf8').split('\n').slice(0, 100).join('\n');
    const d = await runCli(['--stdin', '--ci'], half);
    expect(d.code).toBe(2);
    expect(d.out).toContain('bez run-end');
  }, 60_000);

  it('discovers and subscribes to a daemon over IPC (own mock, vto-ipc/1)', async () => {
    const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-rt-')); fs.chmodSync(rt, 0o700);
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-proj-'));
    const e2 = { ...env, XDG_RUNTIME_DIR: rt, LOCALAPPDATA: rt };
    const daemon = spawn(process.execPath, [TSX, CLI, 'mock-daemon', '--root', proj, '--mock-duration', '2500'], { cwd: TUI, env: e2, stdio: 'pipe' });
    try {
      let err = '';
      daemon.stderr.on('data', (d) => { err += d; });
      for (let i = 0; i < 200 && !err.includes('endpoint'); i++) await new Promise((r) => setTimeout(r, 50));
      const r = await runCli(['--root', proj, '--ci'], undefined, e2);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/Souhrn: 400 prošlo, 7 selhalo/);
    } finally { daemon.kill('SIGINT'); }
  }, 30_000);

  const MCP_MOCK = path.resolve(TUI, '../mcp/dev/mock-events.mjs');
  it.skipIf(!fs.existsSync(MCP_MOCK))('works with the daemon team\'s mock (mcp/dev/mock-events.mjs)', async () => {
    const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-rt-')); fs.chmodSync(rt, 0o700);
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-proj-'));
    const e2 = { ...env, XDG_RUNTIME_DIR: rt, LOCALAPPDATA: rt };
    const daemon = spawn(process.execPath, [MCP_MOCK, '--root', proj, '--speed', '8', '--tests', '200', '--fail', '7'], { cwd: path.dirname(MCP_MOCK), env: e2, stdio: 'pipe' });
    try {
      let err = '';
      daemon.stderr.on('data', (d) => { err += d; });
      for (let i = 0; i < 200 && !err.includes('endpoint'); i++) await new Promise((r) => setTimeout(r, 50));
      const r = await runCli(['--root', proj, '--ci'], undefined, e2);
      expect([0, 1]).toContain(r.code);
      expect(r.out).toMatch(/vto: běh r1 \(dotčené, 200 testů/);
      expect(r.out).toMatch(/Souhrn: \d+ prošlo, 7 selhalo/);
      expect(r.out).toContain("TypeError: Cannot read properties of undefined (reading 'then')");
    } finally { daemon.kill('SIGINT'); }
  }, 30_000);
});

const havePty = process.platform !== 'win32' && spawnSync('python3', ['-c', 'import pty']).status === 0;

describe.skipIf(!havePty)('e2e: interactive TUI in a real pty', () => {
  it('alt screen, keys while the run streams, OSC 52 copy, rerun → fixed, q quits with 0', () => {
    const steps = [
      'until:Selhání', 'wait:1200', 'key:j', 'key:j', 'key:r', 'wait:400', 'key:c', 'wait:300', 'key:f', 'key:f', 'key:f',
      'resize:90x30', 'wait:300', 'key:?', 'key:x', 'until:dokončeno', 'key:R', 'wait:2500', 'key:q',
    ].join(',');
    const r = spawnSync('python3', [path.join(TUI, 'scripts', 'pty-run.py'), '120', '36', steps, '--', process.execPath, TSX, CLI, '--mock', '--mock-speed', '4'], {
      cwd: TUI, env: { ...env, NO_COLOR: undefined, COLORTERM: 'truecolor' }, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 << 20,
    });
    const out = r.stdout;
    expect(r.status).toBe(0);
    expect(out).toContain('\x1b[?1049h'); // entered the alternate screen
    expect(out).toContain('\x1b[?1049l'); // and restored the user's screen
    expect(out).toContain('\x1b[?2026h'); // synchronized output (no tearing)
    // clipboard via OSC 52 only where CI has no clipboard tool (Linux); macOS/Windows runners have pbcopy / clip.exe
    if (process.platform === 'linux') {
      expect(out).toMatch(/\x1b\]52;c;[A-Za-z0-9+/=]{100,}\x07/);
      const b64 = /\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/.exec(out)![1];
      expect(Buffer.from(b64, 'base64').toString('utf8')).toContain('## Selhávající testy');
    }
    expect(out).toContain('opraveno během běhu');
    expect(out).toContain('Znovu spouštím');
    expect(out).toContain('38;2;'); // truecolor
  }, 90_000);

  it('NO_COLOR + ASCII terminal (TERM=linux): no colour escapes, no box drawing', () => {
    const r = spawnSync('python3', [path.join(TUI, 'scripts', 'pty-run.py'), '100', '30', 'until:Selhání,wait:500,key:q', '--', process.execPath, TSX, CLI, '--mock', '--mock-speed', '4'], {
      cwd: TUI, env: { ...env, NO_COLOR: '1', TERM: 'linux', LANG: 'C' }, encoding: 'utf8', timeout: 60_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/\x1b\[(3|4|9|10)\d(;\d+)*m/); // no fg/bg colour SGR
    expect(r.stdout).not.toMatch(/[╭╮╰╯│█]/);
    expect(r.stdout).toContain('+----');
  }, 60_000);
});
