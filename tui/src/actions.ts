// Real side effects behind the UI's Actions interface (editor, clipboard).
import type { Actions, OpenRequest } from './ui/App.js';
import { buildEditorCommand, locateEditor, resolveEditor, unsafeForCmdShim, validateTarget } from './editor.js';
import { resolveInsideRoot } from './safePath.js';
import { copyToClipboard, detectWsl } from './clipboard.js';
import { defaultDeps, type ProcDeps } from './proc.js';

/** Thrown by `openEditor` when no usable editor exists; carries the validated absolute path to show/copy. */
export class NoEditorError extends Error {
  constructor(readonly path: string, readonly line: number, readonly col?: number) { super('no-editor'); this.name = 'NoEditorError'; }
  get location(): string { return `${this.path}:${this.line}${this.col ? ':' + this.col : ''}`; }
}

export function realActions(root: string, opts: { hasTTY: boolean; writeTerminal: (s: string) => void; deps?: ProcDeps }): Actions {
  const deps = opts.deps ?? defaultDeps();
  return {
    async openEditor(target: OpenRequest, suspend) {
      const err = validateTarget(target.file, target.line);
      if (err) throw new Error(err);
      // realpath inside the real root + regular file + source-like extension; UNC/device spellings
      // are rejected before any file-system call
      const res = resolveInsideRoot(root, target.file, { requireSource: true, platform: deps.platform });
      if (!res.ok) throw new Error(`${target.file}: ${res.error}`);
      const abs = res.abs;
      const spec = resolveEditor(deps, opts.hasTTY);
      const exe = spec ? locateEditor(spec, deps) : null;
      // no editor (or one we refuse to run this path through): never the OS default handler –
      // the caller shows the path and copies it
      if (!spec || !exe || unsafeForCmdShim(exe, abs, deps.platform)) throw new NoEditorError(abs, target.line, target.col);
      const cmd = buildEditorCommand({ ...spec, cmd: exe }, abs, target.line, target.col);
      if (cmd.terminal) {
        await suspend(() => new Promise<void>((resolve, reject) => {
          const child = deps.spawn(cmd.cmd, cmd.args, { stdio: 'inherit', cwd: root, shell: false });
          child.on('error', reject);
          child.on('exit', () => resolve());
        }));
        return cmd.name;
      }
      await new Promise<void>((resolve, reject) => {
        const child = deps.spawn(cmd.cmd, cmd.args, { stdio: 'ignore', detached: true, cwd: root, windowsHide: false, shell: false });
        let settled = false;
        child.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
        // ENOENT etc. are reported asynchronously; give it a moment, then let the editor live on its own
        setTimeout(() => { if (!settled) { settled = true; child.unref(); resolve(); } }, 150);
      });
      return cmd.name;
    },
    async copy(text: string) {
      const r = await copyToClipboard(text, { ...deps, writeTerminal: opts.writeTerminal, isWsl: () => detectWsl(deps.env) });
      return r.method;
    },
  };
}
