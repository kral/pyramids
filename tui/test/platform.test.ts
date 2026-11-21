import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { editorArgs, resolveEditor, buildEditorCommand, editorName, familyOf, validateTarget, isTerminalEditor } from '../src/editor.js';
import { splitCommandLine, which, type ProcDeps } from '../src/proc.js';
import { clipboardCandidates, copyToClipboard, osc52, utf16leWithBom } from '../src/clipboard.js';
import { detectColorLevel, detectUnicode, bar, initTerm, prefersFullRedraw } from '../src/term.js';
import { runtimeBase, projectKey, endpointDir } from '../src/sources/protocol.js';

const fsDeps = (platform: NodeJS.Platform, env: Record<string, string>, files: string[]) => ({
  platform, env, exists: (p: string) => files.includes(p),
});

describe('editor', () => {
  it('line syntax per editor family', () => {
    expect(editorArgs('vscode', '/p/a.ts', 12, 5)).toEqual(['-g', '/p/a.ts:12:5']);
    expect(editorArgs('jetbrains', '/p/a.ts', 12, 5)).toEqual(['--line', '12', '--column', '5', '/p/a.ts']);
    expect(editorArgs('vim', '/p/a.ts', 12)).toEqual(['+12', '/p/a.ts']);
    expect(editorArgs('vim', '/p/a.ts', 12, 5)).toEqual(['+call cursor(12,5)', '/p/a.ts']);
    expect(editorArgs('nano', '/p/a.ts', 12, 5)).toEqual(['+12,5', '/p/a.ts']);
    expect(editorArgs('emacs', '/p/a.ts', 12, 5)).toEqual(['+12:5', '/p/a.ts']);
    expect(editorArgs('colon', '/p/a.ts', 12)).toEqual(['/p/a.ts:12']);
    expect(editorArgs('notepadpp', 'C:\\p\\a.ts', 12, 3)).toEqual(['-n12', '-c3', 'C:\\p\\a.ts']);
    expect(editorArgs('unknown', '/p/a.ts', 0)).toEqual(['/p/a.ts']);
  });
  it('recognises editors by basename (Windows shims, .app paths)', () => {
    expect(editorName('C:\\Users\\j\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd')).toBe('code');
    expect(editorName('/Applications/WebStorm.app/Contents/MacOS/webstorm')).toBe('webstorm');
    expect(familyOf('webstorm64')).toBe('jetbrains');
    expect(familyOf('nvim')).toBe('vim');
    expect(familyOf('cursor')).toBe('vscode');
    expect(familyOf('hx')).toBe('colon');
  });
  it('resolution order: VTO_EDITOR > VISUAL > VS Code terminal > EDITOR > PATH', () => {
    const files = ['/usr/bin/code', '/usr/bin/nvim', '/usr/bin/xdg-open'];
    const base = { PATH: '/usr/bin' };
    expect(resolveEditor(fsDeps('linux', { ...base, VTO_EDITOR: 'webstorm', VISUAL: 'vim' }, files), true)!.name).toBe('webstorm');
    expect(resolveEditor(fsDeps('linux', { ...base, VISUAL: 'code --wait', EDITOR: 'vim' }, files), true)).toMatchObject({ name: 'code', baseArgs: ['--wait'], source: 'VISUAL' });
    expect(resolveEditor(fsDeps('linux', { ...base, TERM_PROGRAM: 'vscode', EDITOR: 'vim' }, files), true)).toMatchObject({ name: 'code', source: 'TERM_PROGRAM' });
    expect(resolveEditor(fsDeps('linux', { ...base, EDITOR: 'nvim' }, files), true)!.name).toBe('nvim');
    expect(resolveEditor(fsDeps('linux', base, files), true)!.name).toBe('code');
    expect(resolveEditor(fsDeps('linux', base, ['/usr/bin/nvim']), true)!.name).toBe('nvim');
    expect(resolveEditor(fsDeps('linux', base, ['/usr/bin/xdg-open']), false)).toBeNull(); // no OS-opener fallback (S-N4)
    expect(resolveEditor(fsDeps('linux', base, []), false)).toBeNull();
  });
  it('Windows: PATHEXT lookup finds code.cmd', () => {
    const deps = fsDeps('win32', { Path: 'C:\\VS\\bin;C:\\Windows', PATHEXT: '.COM;.EXE;.BAT;.CMD' }, ['C:\\VS\\bin\\code.cmd']);
    expect(which('code', deps)).toBe('C:\\VS\\bin\\code.cmd');
    expect(resolveEditor(deps, true)).toMatchObject({ name: 'code', family: 'vscode', cmd: 'C:\\VS\\bin\\code.cmd' });
  });
  it('builds commands without a shell; drops --wait for VS Code; terminal editors flagged', () => {
    const spec = { cmd: 'code', baseArgs: ['--wait', '-r'], name: 'code', family: 'vscode' as const, source: 'VISUAL' };
    expect(buildEditorCommand(spec, '/p/$(rm -rf ~).ts', 3)).toEqual({ cmd: 'code', args: ['-r', '-g', '/p/$(rm -rf ~).ts:3'], terminal: false, name: 'code' });
    expect(isTerminalEditor({ cmd: 'vim', baseArgs: [], name: 'vim', family: 'vim', source: 'EDITOR' })).toBe(true);
    expect(isTerminalEditor({ cmd: 'gvim', baseArgs: [], name: 'gvim', family: 'vim', source: 'EDITOR' })).toBe(false);
    expect(isTerminalEditor({ cmd: 'emacsclient', baseArgs: ['-t'], name: 'emacsclient', family: 'emacsclient', source: 'EDITOR' })).toBe(true);
    expect(validateTarget('a\nb', 1)).toBeTruthy();
    expect(validateTarget('a.ts', 0)).toBeTruthy();
    expect(validateTarget('a.ts', 4)).toBeNull();
  });
  it('splits $EDITOR like a shell would, without expansion', () => {
    expect(splitCommandLine('code --wait')).toEqual(['code', '--wait']);
    expect(splitCommandLine('"C:\\Program Files\\Notepad++\\notepad++.exe" -multiInst')).toEqual(['C:\\Program Files\\Notepad++\\notepad++.exe', '-multiInst']);
    expect(splitCommandLine("emacsclient -t -a ''")).toEqual(['emacsclient', '-t', '-a', '']);
    expect(splitCommandLine('vim $(evil)')).toEqual(['vim', '$(evil)']);
  });
});

describe('clipboard', () => {
  const cands = (platform: NodeJS.Platform, env: Record<string, string>, files: string[] = [], wsl = false) =>
    clipboardCandidates({ ...fsDeps(platform, { PATH: '/usr/bin', ...env }, files), isWsl: () => wsl }, 'ěšč').map((c) => c.method);
  it('picks tools per platform', () => {
    expect(cands('darwin', {})).toEqual(['pbcopy']);
    expect(cands('win32', {})).toEqual(['clip.exe', 'PowerShell']);
    expect(cands('linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, ['/usr/bin/wl-copy', '/usr/bin/xclip'])).toEqual(['wl-copy', 'xclip']);
    expect(cands('linux', { DISPLAY: ':0' }, ['/usr/bin/xsel'])).toEqual(['xsel']);
    expect(cands('linux', {}, [], true)).toEqual(['clip.exe (WSL)']);
    expect(cands('linux', { SSH_TTY: '/dev/pts/1' }, ['/usr/bin/xclip'])).toEqual([]); // ssh → OSC 52
  });
  it('clip.exe gets UTF-16LE with BOM (diacritics survive)', () => {
    const b = utf16leWithBom('Kč');
    expect([...b]).toEqual([0xff, 0xfe, 0x4b, 0x00, 0x0d, 0x01]);
  });
  it('OSC 52, wrapped for tmux', () => {
    expect(osc52('hi', {})).toBe('\x1b]52;c;aGk=\x07');
    expect(osc52('hi', { TMUX: '1' })).toBe('\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\');
  });
  it('falls back through candidates to OSC 52', async () => {
    const written: string[] = [];
    const calls: string[] = [];
    const spawn = ((cmd: string) => {
      calls.push(cmd);
      const child = new EventEmitter() as any;
      child.stdin = Object.assign(new EventEmitter(), { end: () => setTimeout(() => child.emit('exit', 1), 1) });
      child.kill = () => {};
      return child;
    }) as unknown as ProcDeps['spawn'];
    const r = await copyToClipboard('x', { platform: 'win32', env: {}, exists: () => false, spawn, writeTerminal: (s) => written.push(s), isWsl: () => false });
    expect(calls).toEqual(['C:\\Windows\\System32\\clip.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']);
    expect(r.method).toBe('OSC 52');
    expect(written[0]).toContain(']52;c;');
  });
});

describe('terminal capabilities', () => {
  it('colour level: NO_COLOR, FORCE_COLOR, truecolor, 256, dumb', () => {
    expect(detectColorLevel({ NO_COLOR: '1', COLORTERM: 'truecolor' }, true)).toBe(0);
    expect(detectColorLevel({ NO_COLOR: '1', FORCE_COLOR: '2' }, true)).toBe(2);
    expect(detectColorLevel({ FORCE_COLOR: '0' }, true)).toBe(0);
    expect(detectColorLevel({ COLORTERM: 'truecolor' }, true)).toBe(3);
    expect(detectColorLevel({ WT_SESSION: 'x' }, true, 'win32')).toBe(3);
    expect(detectColorLevel({ TERM: 'xterm-256color' }, true, 'linux')).toBe(2);
    expect(detectColorLevel({ TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' }, true, 'darwin')).toBe(2);
    expect(detectColorLevel({ TERM: 'xterm' }, true, 'linux')).toBe(1);
    expect(detectColorLevel({ TERM: 'dumb' }, true)).toBe(0);
    expect(detectColorLevel({}, false)).toBe(0);
  });
  it('unicode: locale and Windows terminals', () => {
    expect(detectUnicode({ LANG: 'cs_CZ.UTF-8' }, 'linux')).toBe(true);
    expect(detectUnicode({ LANG: 'C' }, 'linux')).toBe(false);
    expect(detectUnicode({ TERM: 'linux', LANG: 'cs_CZ.UTF-8' }, 'linux')).toBe(false);
    expect(detectUnicode({}, 'darwin')).toBe(true);
    expect(detectUnicode({ WT_SESSION: '1' }, 'win32')).toBe(true);
    expect(detectUnicode({}, 'win32')).toBe(false); // legacy conhost
    expect(detectUnicode({ VTO_ASCII: '1', WT_SESSION: '1' }, 'win32')).toBe(false);
  });
  it('redraw strategy: full only where synchronized output is known', () => {
    expect(prefersFullRedraw({ WT_SESSION: '1' })).toBe(true);
    expect(prefersFullRedraw({ TERM_PROGRAM: 'iTerm.app' })).toBe(true);
    expect(prefersFullRedraw({ TERM_PROGRAM: 'Apple_Terminal' })).toBe(false);
    expect(prefersFullRedraw({ TERM_PROGRAM: 'iTerm.app', TMUX: '/tmp/x' })).toBe(false);
    expect(prefersFullRedraw({})).toBe(false);
    expect(prefersFullRedraw({ VTO_UI_REDRAW: 'full' })).toBe(true);
    expect(prefersFullRedraw({ WT_SESSION: '1', VTO_UI_REDRAW: 'incremental' })).toBe(false);
  });
  it('progress bar with sub-cell precision and ASCII fallback', () => {
    initTerm({ colorLevel: 0, unicode: true, sgr: false });
    expect(bar(0.5, 10)).toEqual({ full: '█████', empty: '░░░░░' });
    expect(bar(0.55, 10).full).toBe('█████▌');
    expect(bar(2, 4)).toEqual({ full: '████', empty: '' });
    initTerm({ colorLevel: 0, unicode: false, sgr: false });
    expect(bar(0.5, 4)).toEqual({ full: '##', empty: '..' });
    initTerm({ colorLevel: 0, unicode: true, sgr: false });
  });
});

describe('IPC endpoint discovery', () => {
  it('runtime dir + project key match the daemon (mcp/src/ipc.mjs) when present', async () => {
    const home = '/home/dev';
    expect(runtimeBase({ platform: 'linux', env: {}, home })).toBe('/home/dev/.cache/vto/run');
    expect(runtimeBase({ platform: 'darwin', env: {}, home })).toBe('/home/dev/Library/Caches/vto/run');
    expect(runtimeBase({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\Žofie\\AppData\\Local' }, home })).toBe('C:\\Users\\Žofie\\AppData\\Local\\vto\\run');
    expect(projectKey('/home/dev/proj', false)).toMatch(/^[0-9a-f]{16}$/);
    expect(projectKey('/home/dev/Proj', true)).toBe(projectKey('/home/dev/proj', true));
    const p = path.resolve(__dirname, '../../mcp/src/ipc.mjs');
    if (!fs.existsSync(p)) return;
    const mcp = await import(p);
    for (const platform of ['linux', 'darwin', 'win32']) {
      const o = { platform, env: { LOCALAPPDATA: 'C:/L', XDG_CACHE_HOME: '/xdg' }, home };
      expect(runtimeBase(o)).toBe(mcp.runtimeBase(o));
    }
    for (const root of [__dirname, path.resolve(__dirname, '..'), '/nonexistent/x']) {
      expect(projectKey(root)).toBe(mcp.projectKey(root));
      expect(endpointDir(root)).toBe(mcp.endpointDir(root));
    }
  });
});
