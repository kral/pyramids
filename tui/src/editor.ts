// "Open file:line in editor" – resolution order, per-editor line syntax, safe spawning.
//
// Resolution: VTO_EDITOR > VISUAL > (inside VS Code's terminal: code) > EDITOR > auto-detect
// (code, cursor, codium, zed, webstorm, idea, subl; then nvim/vim/nano when we have a TTY).
//
// There is deliberately NO fallback to the OS default handler (xdg-open / open / explorer.exe /
// start): a default handler *executes* many file types (.desktop, .lnk, .cmd, .js via Windows
// Script Host…), and the path comes from test output. Without an editor the UI shows the path
// and copies it to the clipboard instead. Openers are refused even when $EDITOR names one.
import path from 'node:path';
import { which, splitCommandLine, type ProcDeps } from './proc.js';

export type EditorFamily =
  | 'vscode' | 'jetbrains' | 'vim' | 'nano' | 'emacs' | 'emacsclient' | 'colon' | 'kak' | 'notepadpp' | 'mate' | 'unknown';

export interface EditorSpec { cmd: string; baseArgs: string[]; name: string; family: EditorFamily; source: string }
export interface EditorCommand { cmd: string; args: string[]; /** needs the terminal (suspend TUI, inherit stdio, wait) */ terminal: boolean; name: string }

const VSCODE = /^(code|code-insiders|codium|vscodium|cursor|windsurf|positron|code-oss)$/;
const JETBRAINS = /^(idea|idea64|webstorm|webstorm64|phpstorm|phpstorm64|pycharm|pycharm64|charm|goland|goland64|rider|rider64|clion|clion64|rubymine|rubymine64|rustrover|rustrover64|datagrip|studio|studio64|aqua|fleet)$/;
const VIM = /^(vi|vim|nvim|gvim|mvim|view|vimx|lvim)$/;
const COLON = /^(hx|helix|micro|subl|sublime_text|zed|zeditor|lapce|nova)$/;
const TERMINAL_EDITORS = /^(vi|vim|nvim|view|vimx|lvim|nano|pico|micro|hx|helix|kak|joe|ne|mg|emacs|jed)$/;

/** Programs that launch a file with its default handler or run it: never used as an editor. */
const OPENERS = /^(open|xdg-open|gio|gvfs-open|gnome-open|kde-open|kde-open5|kioclient|kioclient5|exo-open|wslview|cygstart|start|explorer|rundll32|cmd|command|powershell|pwsh|wscript|cscript|mshta|sh|bash|zsh|fish|dash|env|node|python|python3|perl|ruby)$/;
export function isOpener(name: string): boolean { return OPENERS.test(name); }

export function editorName(cmd: string): string {
  const base = path.win32.basename(path.posix.basename(cmd)).toLowerCase();
  return base.replace(/\.(exe|cmd|bat|sh|com|app)$/, '');
}

export function familyOf(name: string): EditorFamily {
  if (VSCODE.test(name)) return 'vscode';
  if (JETBRAINS.test(name)) return 'jetbrains';
  if (VIM.test(name)) return 'vim';
  if (name === 'nano' || name === 'pico') return 'nano';
  if (name === 'emacs') return 'emacs';
  if (name === 'emacsclient') return 'emacsclient';
  if (name === 'kak' || name === 'joe' || name === 'ne' || name === 'mg' || name === 'jed') return 'kak';
  if (COLON.test(name)) return 'colon';
  if (name === 'notepad++') return 'notepadpp';
  if (name === 'mate') return 'mate';
  return 'unknown';
}

function spec(value: string, source: string): EditorSpec | null {
  const argv = splitCommandLine(value.trim());
  if (!argv.length) return null;
  const name = editorName(argv[0]);
  if (isOpener(name)) return null; // fall through to the next candidate
  return { cmd: argv[0], baseArgs: argv.slice(1), name, family: familyOf(name), source };
}

export function resolveEditor(deps: Pick<ProcDeps, 'platform' | 'env' | 'exists'>, hasTTY: boolean): EditorSpec | null {
  const env = deps.env;
  for (const [k, v] of [['VTO_EDITOR', env.VTO_EDITOR], ['VISUAL', env.VISUAL]] as const) {
    const sp = v && v.trim() ? spec(v, k) : null;
    if (sp) return sp;
  }
  if (env.TERM_PROGRAM === 'vscode') {
    // Cursor/Windsurf also report "vscode"; their CLI is on PATH under their own name
    const hint = (env.VSCODE_GIT_ASKPASS_NODE ?? '').toLowerCase();
    const order = hint.includes('cursor') ? ['cursor', 'code'] : hint.includes('windsurf') ? ['windsurf', 'code'] : ['code', 'code-insiders', 'cursor', 'codium'];
    for (const n of order) { const p = which(n, deps); if (p) return { cmd: p, baseArgs: [], name: n, family: 'vscode', source: 'TERM_PROGRAM' }; }
  }
  const fromEditor = env.EDITOR && env.EDITOR.trim() ? spec(env.EDITOR, 'EDITOR') : null;
  if (fromEditor) return fromEditor;
  const gui = ['code', 'cursor', 'codium', 'zed', 'webstorm', 'idea', 'subl'];
  for (const n of gui) { const p = which(n, deps); if (p) return { cmd: p, baseArgs: [], name: n, family: familyOf(n), source: 'PATH' }; }
  if (hasTTY && deps.platform !== 'win32') {
    for (const n of ['nvim', 'vim', 'nano', 'vi']) { const p = which(n, deps); if (p) return { cmd: p, baseArgs: [], name: n, family: familyOf(n), source: 'PATH' }; }
  }
  return null;
}

/** argv for opening `file` (absolute) at line/col. Pure – unit-tested per editor family. */
export function editorArgs(family: EditorFamily, file: string, line: number, col?: number): string[] {
  const l = Math.max(1, Math.floor(line) || 1);
  const c = col && col > 0 ? Math.floor(col) : undefined;
  switch (family) {
    case 'vscode': return ['-g', `${file}:${l}${c ? ':' + c : ''}`];
    case 'jetbrains': return ['--line', String(l), ...(c ? ['--column', String(c)] : []), file];
    case 'vim': return [c ? `+call cursor(${l},${c})` : `+${l}`, file];
    case 'nano': return [`+${l}${c ? ',' + c : ''}`, file];
    case 'emacs': case 'emacsclient': case 'kak': return [`+${l}${c ? ':' + c : ''}`, file];
    case 'colon': return [`${file}:${l}${c ? ':' + c : ''}`];
    case 'notepadpp': return [`-n${l}`, ...(c ? [`-c${c}`] : []), file];
    case 'mate': return ['-l', String(l), file];
    case 'unknown': default: return [file];
  }
}

export function isTerminalEditor(s: EditorSpec): boolean {
  const tty = s.baseArgs.some((a) => a === '-t' || a === '-nw' || a === '--tty' || a === '--no-window-system');
  if (s.family === 'emacsclient' || s.family === 'emacs') return tty;
  if (s.name === 'gvim' || s.name === 'mvim') return false;
  return TERMINAL_EDITORS.test(s.name);
}

/** Reject anything that is not a plain path + positive integers (defence in depth: no shell is used anyway). */
export function validateTarget(file: string, line: number): string | null {
  if (!file || /[\0\r\n]/.test(file)) return 'invalid path';
  if (!Number.isFinite(line) || line < 1) return 'invalid line';
  return null;
}

/**
 * Absolute path of the editor executable. PATH lookup is done here (never the current directory,
 * which on Windows is searched first by CreateProcess/cmd.exe and is the untrusted project).
 */
export function locateEditor(s: EditorSpec, deps: Pick<ProcDeps, 'platform' | 'env' | 'exists'>): string | null {
  const p = deps.platform === 'win32' ? path.win32 : path.posix;
  if (p.isAbsolute(s.cmd)) return deps.exists(s.cmd) ? s.cmd : (deps.platform === 'win32' ? which(s.cmd, deps) : null);
  if (s.cmd.includes('/') || (deps.platform === 'win32' && s.cmd.includes('\\'))) return null; // relative path: would resolve inside the project
  return which(s.cmd, deps);
}

/** cmd.exe metacharacters. A `.cmd`/`.bat` editor shim is run through cmd.exe; such a path is not passed to it. */
export function unsafeForCmdShim(cmd: string, file: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(cmd) && /["%!^&|<>()\r\n]/.test(file);
}

export function buildEditorCommand(s: EditorSpec, absFile: string, line: number, col?: number): EditorCommand {
  // absolute path never starts with "-" → cannot be parsed as an editor option
  // VS Code: drop --wait – we do not block on a GUI editor
  const base = s.family === 'vscode' ? s.baseArgs.filter((a) => a !== '--wait' && a !== '-w') : s.baseArgs;
  return { cmd: s.cmd, args: [...base, ...editorArgs(s.family, absFile, line, col)], terminal: isTerminalEditor(s), name: s.name };
}
