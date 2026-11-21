// Cross-platform clipboard: pbcopy / clip.exe (also from WSL) / wl-copy / xclip / xsel, then the
// OSC 52 escape sequence (works over SSH and in tmux/screen when the terminal allows it).
import fs from 'node:fs';
import { runWithInput, which, type ProcDeps } from './proc.js';
import { cleanText } from './sanitize.js';

/** Windows system tools by absolute path: a bare `clip.exe` is looked up in the current directory (the project) first. */
function system32(env: Record<string, string | undefined>, exe: string): string {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  return `${root}\\System32\\${exe}`;
}

export interface ClipboardResult { method: string }
export interface ClipboardDeps extends ProcDeps {
  writeTerminal: (s: string) => void;
  isWsl: () => boolean;
}

export function detectWsl(env: Record<string, string | undefined>): boolean {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try { return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch { return false; }
}

/** clip.exe decodes stdin in the console code page unless it starts with a UTF-16LE BOM. */
export function utf16leWithBom(s: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
}

export function osc52(text: string, env: Record<string, string | undefined>): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const seq = `\x1b]52;c;${b64}\x07`;
  if (env.TMUX) return `\x1bPtmux;${seq.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`;
  if ((env.TERM ?? '').startsWith('screen') && !env.TMUX) return `\x1bP${seq}\x1b\\`;
  return seq;
}

interface Candidate { method: string; cmd: string; args: string[]; input: Buffer | string; env?: Record<string, string> }

export function clipboardCandidates(deps: Pick<ClipboardDeps, 'platform' | 'env' | 'exists' | 'isWsl'>, text: string): Candidate[] {
  const env = deps.env;
  const c: Candidate[] = [];
  const has = (n: string) => which(n, deps);
  if (deps.platform === 'darwin') {
    // pbcopy picks the encoding from the locale; force UTF-8 so "ěščřžýáíé" survive
    c.push({ method: 'pbcopy', cmd: 'pbcopy', args: [], input: text, env: { LC_CTYPE: 'UTF-8', LANG: env.LANG?.includes('UTF-8') ? env.LANG : 'en_US.UTF-8' } });
  } else if (deps.platform === 'win32') {
    c.push({ method: 'clip.exe', cmd: system32(env, 'clip.exe'), args: [], input: utf16leWithBom(text) });
    c.push({ method: 'PowerShell', cmd: system32(env, 'WindowsPowerShell\\v1.0\\powershell.exe'), args: ['-NoProfile', '-NonInteractive', '-Command', '[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'], input: text });
  } else {
    const sshOnly = (env.SSH_TTY || env.SSH_CONNECTION) && !env.DISPLAY && !env.WAYLAND_DISPLAY;
    if (!sshOnly) {
      if (env.WAYLAND_DISPLAY && has('wl-copy')) c.push({ method: 'wl-copy', cmd: 'wl-copy', args: ['--type', 'text/plain;charset=utf-8'], input: text });
      if (env.DISPLAY && has('xclip')) c.push({ method: 'xclip', cmd: 'xclip', args: ['-selection', 'clipboard', '-in'], input: text });
      if (env.DISPLAY && has('xsel')) c.push({ method: 'xsel', cmd: 'xsel', args: ['--clipboard', '--input'], input: text });
      if (deps.isWsl()) c.push({ method: 'clip.exe (WSL)', cmd: has('clip.exe') ?? '/mnt/c/Windows/System32/clip.exe', args: [], input: utf16leWithBom(text) });
      if (has('termux-clipboard-set')) c.push({ method: 'termux', cmd: 'termux-clipboard-set', args: [], input: text });
    }
  }
  return c;
}

/**
 * Everything put on the clipboard is sanitised first: raw ESC (bracketed-paste terminator
 * `ESC[201~`, OSC), other control characters, bidi and invisible/tag characters never reach the
 * place the user pastes into (a shell, an agent prompt).
 */
export async function copyToClipboard(rawText: string, deps: ClipboardDeps, allowOsc52 = true): Promise<ClipboardResult> {
  const text = cleanText(rawText, 200_000);
  const errors: string[] = [];
  for (const cand of clipboardCandidates(deps, text)) {
    try { await runWithInput(deps, cand.cmd, cand.args, cand.input, cand.env); return { method: cand.method }; }
    catch (e) { errors.push(`${cand.method}: ${(e as Error).message}`); }
  }
  if (allowOsc52) { deps.writeTerminal(osc52(text, deps.env)); return { method: 'OSC 52' }; }
  throw new Error(errors.join('; ') || 'no clipboard tool');
}
