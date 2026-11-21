// Details pane content for one failure as styled lines (pure; snapshot-tested through the UI).
import { classifyDiff } from '../diff.js';
import { codeFrame, type CodeFrame, type SourceCache } from '../codeframe.js';
import { nameOfTestId } from '../events.js';
import { t } from '../i18n.js';
import { failingLocation, projectFrame, type FailureItem, type RunState } from '../model.js';
import { getCaps, glyphs } from '../term.js';
import { s, wrapPlain, type SegLineT } from './segments.js';

function frameLines(fr: CodeFrame, label: string, width: number): SegLineT[] {
  const g = glyphs();
  const out: SegLineT[] = [];
  out.push([s(label, 'accent', { bold: true }), s('  '), s(`${fr.file}:${fr.line}${fr.col ? ':' + fr.col : ''}`, 'muted')]);
  if (!fr.lines.length) { out.push([s('  ' + t('fileNotReadable', { file: fr.file }), 'muted')]); return out; }
  const w = String(fr.lines.at(-1)!.no).length;
  for (const l of fr.lines) {
    const gutter: SegLineT = [
      s(l.highlight ? g.pointer + ' ' : '  ', l.highlight ? 'fail' : undefined, { bold: true }),
      s(String(l.no).padStart(w) + ' ' + g.vline + ' ', l.highlight ? 'fail' : 'gutter'),
    ];
    out.push([...gutter, ...l.tokens.map((tk) => s(tk.text, tk.color, { bold: l.highlight && !tk.color ? true : undefined }))]);
    if (l.highlight && fr.col && fr.col > 0) {
      const caretPad = Math.min(fr.col - 1, Math.max(0, width - w - 8));
      out.push([s('  ' + ' '.repeat(w) + ' ' + g.vline + ' ', 'gutter'), s(' '.repeat(caretPad) + '^', 'fail', { bold: true })]);
    }
  }
  if (!fr.fromDisk) out.push([s('  (' + t('fileNotReadable', { file: fr.file }).replace(/^\(|\)$/g, '') + ')', 'muted', { dim: true })]);
  return out;
}

export function detailsLines(run: RunState, f: FailureItem, cache: SourceCache, width: number): SegLineT[] {
  const g = glyphs();
  const out: SegLineT[] = [];
  const st = f.fix;
  const icon = st === 'fixed' ? s(g.fixed + ' ', 'fixed', { bold: true }) : st === 'pending' ? s(g.pending + ' ', 'pending', { bold: true }) : s(g.fail + ' ', 'fail', { bold: true });
  const badge = st === 'fixed' ? s('  ' + t('fixedDuringRun'), 'fixed', { bold: true })
    : st === 'still-failing' ? s('  ' + t('stillFailing'), 'fail')
    : st === 'pending' ? s('  ' + t('rerunning'), 'pending') : null;
  out.push([icon, s(nameOfTestId(f.id), st === 'fixed' ? 'fixed' : undefined, { bold: true })]);
  const grp = run.groups.get(f.groupKey);
  const meta: SegLineT = [...(badge ? [{ ...badge, text: badge.text.trimStart() + '  ' }] : []), s(`${f.file}:${f.line}`, 'accent2')];
  if (f.project) meta.push(s(`  ${g.dot} ${f.project}`, 'muted'));
  if (grp && grp.ids.length > 1) meta.push(s(`  ${g.dot} ${t('sameErrorIn', { n: grp.ids.length })}`, 'pending'));
  out.push(meta);
  out.push([]);

  out.push([s(t('message'), 'accent', { bold: true })]);
  for (const l of wrapPlain(f.message, width - 2, '  ')) out.push([s('  ' + l, st === 'fixed' ? 'muted' : 'fail')]);

  if (f.diff) {
    out.push([]);
    out.push([s(t('diff'), 'accent', { bold: true })]);
    const d = classifyDiff(f.diff);
    for (const [i, l] of d.lines.entries()) {
      // Vitest puts an empty line between the header and the body – drop it (vertical space is scarce)
      if (l.kind === 'context' && !l.text.trim() && d.lines[i - 1]?.kind === 'header') continue;
      if (l.kind === 'header') {
        out.push([s('  ' + (l.text.startsWith('-') ? `- ${t('expected')}` : `+ ${t('received')}`), l.text.startsWith('-') ? 'expected' : 'received')]);
      } else {
        const color = l.kind === 'expected' ? 'expected' : l.kind === 'received' ? 'received' : 'muted';
        // make invisible differences visible (NBSP, trailing spaces)
        const vis = l.text.replace(/\u00a0/g, getCaps().unicode ? '\u2423' : '_').replace(/\t/g, getCaps().unicode ? '\u2192' : '  ');
        out.push([s('  ' + (l.kind === 'context' ? l.text : vis), color)]);
      }
    }
    if (d.truncated) out.push([s(`  ${g.ellipsis} (+${d.truncated})`, 'muted')]);
  }

  out.push([]);
  const loc = failingLocation(f);
  const failing = codeFrame(cache, loc.file, loc.line, loc.col, loc.code);
  out.push(...frameLines(failing, t('failingLine'), width));
  const pf = projectFrame(f);
  if (pf) {
    out.push([]);
    out.push(...frameLines(codeFrame(cache, pf.file, pf.line, pf.col, pf.code), t('projectFrame'), width));
  }
  if (f.coveredChanged.length) {
    out.push([]);
    out.push([s(t('coveredChanged') + ': ', 'accent', { bold: true }), s(f.coveredChanged.slice(0, 5).join(', '), 'pending')]);
  }
  if (grp && grp.ids.length > 1) {
    out.push([]);
    out.push([s(`${t('tests')} (${grp.ids.length})`, 'accent', { bold: true })]);
    for (const id of grp.ids.slice(0, 50)) {
      const m = run.failures.get(id);
      const fixed = m?.fix === 'fixed';
      out.push([s('  '), s(fixed ? g.fixed : g.fail, fixed ? 'fixed' : 'fail'), s(' ' + nameOfTestId(id), id === f.id ? undefined : 'muted', { bold: id === f.id })]);
    }
    if (grp.ids.length > 50) out.push([s(`  ${g.ellipsis} +${grp.ids.length - 50}`, 'muted')]);
  }
  return out;
}

/** Where `o` opens: the first project frame outside the test file (place to fix), else the failing line. */
export function openTarget(f: FailureItem, which: 'fix' | 'test'): { file: string; line: number; col?: number } {
  // load errors / unhandled errors carry line 0
  const fr = (which === 'fix' ? projectFrame(f) : undefined) ?? failingLocation(f);
  return { file: fr.file, line: Math.max(1, fr.line), col: fr.col };
}
