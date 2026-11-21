import React, { memo } from 'react';
import { Box, Text } from 'ink';
import { c, getCaps, glyphs, bar } from '../term.js';
import { t, type MsgKey } from '../i18n.js';
import { formatMs, type HeaderModel, type Row, type FilterMode } from '../view.js';
import type { RunState } from '../model.js';
import { nameOfTestId } from '../events.js';
import { s, truncateLine, padLine, lineWidth, toAnsi, type Seg, type SegLineT } from './segments.js';

// ------------------------------------------------------------------ primitives
const AnsiLine = memo(function AnsiLine({ text }: { text: string }) {
  return <Text wrap="truncate-end">{text || ' '}</Text>;
});

export function SegLine({ line, width }: { line: SegLineT; width: number }) {
  return <AnsiLine text={toAnsi(truncateLine(line, width, glyphs().ellipsis))} />;
}

function Pane({ width, height, focused, children }: { width: number; height: number; focused: boolean; children: React.ReactNode }) {
  return (
    <Box
      width={width}
      height={height}
      flexDirection="column"
      borderStyle={glyphs().border}
      borderColor={c(focused ? 'borderFocus' : 'border')}
      // lines are pre-truncated to the inner width, so only vertical clipping is needed
      // (horizontal clipping makes Ink re-tokenize every line each frame)
      overflowY="hidden"
      paddingX={1}
    >
      {children}
    </Box>
  );
}

// ------------------------------------------------------------------ header
function kindLabel(kind: string): string {
  const k = `kind_${kind}` as MsgKey;
  return ['affected', 'full', 'tests', 'failed'].includes(kind) ? t(k) : kind;
}

export function headerLines(h: HeaderModel | null, width: number, spin: number, source: string, status: string): SegLineT[] {
  const g = glyphs();
  if (!h) {
    return [
      [s(' vto ui ', 'accent', { bold: true, inverse: true }), s('  '), s(g.spinner[spin % g.spinner.length] + ' ', 'pending'), s(t('waiting'))],
      [s(t('waitingSource', { source }) + (status && status !== 'live' ? `  (${status})` : ''), 'muted')],
    ];
  }
  const lines: SegLineT[] = [];
  const state: SegLineT = h.ended
    ? [s(h.failed - h.fixed > 0 ? g.fail : g.pass, h.failed - h.fixed > 0 ? 'fail' : 'pass', { bold: true }), s(` ${t('finished')} ${formatMs(h.elapsedMs)}`)]
    : [s(g.spinner[spin % g.spinner.length], 'pending'), s(` ${t('running')} ${formatMs(h.elapsedMs)}`), ...(h.etaMs !== undefined ? [s(` ${g.dot} ${t('eta')} ~${formatMs(h.etaMs)}`, 'muted')] : [])];
  const left: SegLineT = [
    s(' vto ui ', 'accent', { bold: true, inverse: true }),
    s(`  ${t('run')} `), s(h.runId, 'accent2', { bold: true }),
    s(` ${g.dot} ${kindLabel(h.kind)}`), ...(h.pool ? [s(` ${g.dot} ${h.pool}`, 'muted')] : []),
    ...(status && status !== 'live' && status !== 'ended' ? [s(` ${g.dot} ${status}`, 'pending')] : []),
  ];
  const gap = Math.max(2, width - lineWidth(left) - lineWidth(state));
  lines.push([...left, s(' '.repeat(gap)), ...state]);

  const frac = h.total ? h.done / h.total : 0;
  const counts: SegLineT = [
    s(`  ${g.pass} ${h.passed}`, 'pass'), s(`  ${g.fail} ${h.failed}`, h.failed ? 'fail' : 'muted', { bold: h.failed > 0 }),
    s(`  ${g.skip} ${h.skipped}`, 'skip'),
    ...(h.fixed ? [s(`  ${g.fixed} ${h.fixed} ${t('fixed')}`, 'fixed', { bold: true })] : []),
    ...(h.groups ? [s(`  ${g.dot} ${h.groups} ${t('groups')}`, 'muted')] : []),
  ];
  const nums = `  ${h.done}/${h.total}  ${String(Math.floor(frac * 100)).padStart(3)} %`;
  const barW = Math.max(10, Math.min(48, width - lineWidth(counts) - nums.length - 2));
  const b = bar(frac, barW);
  const barColor = h.failed - h.fixed > 0 ? 'fail' : 'pass';
  lines.push([s(' '), s(b.full, barColor), s(b.empty, 'border'), s(nums), ...counts]);

  if (h.projects.length > 1 || (h.projects.length === 1 && h.projects[0].total)) {
    let cur: SegLineT = [];
    const nameW = Math.min(12, Math.max(...h.projects.map((p) => p.name.length)));
    for (const p of h.projects) {
      const pb = bar(p.total ? p.done / p.total : 0, 14);
      const cell: SegLineT = [
        s(' ' + p.name.padEnd(nameW).slice(0, nameW) + ' ', 'accent2'),
        ...(p.total ? [s(pb.full, p.failed ? 'fail' : 'pass'), s(pb.empty, 'border'), s(` ${p.done}/${p.total}`)] : [s(`${p.done} ${t('done')}`)]),
        ...(p.failed ? [s(` ${g.fail}${p.failed}`, 'fail')] : []),
        s('   '),
      ];
      if (cur.length && lineWidth(cur) + lineWidth(cell) > width) { lines.push(cur); cur = []; if (lines.length >= 4) break; }
      cur.push(...cell);
    }
    if (cur.length && lines.length < 5) lines.push(cur);
  }
  return lines;
}

// ------------------------------------------------------------------ list
const statusGlyph = (st: Row['status']): Seg => {
  const g = glyphs();
  switch (st) {
    case 'fixed': return s(g.fixed, 'fixed', { bold: true });
    case 'pending': return s(g.pending, 'pending', { bold: true });
    case 'partial': return s(g.fail, 'pending', { bold: true });
    default: return s(g.fail, 'fail', { bold: true });
  }
};

export function rowLine(run: RunState, row: Row, selected: boolean, width: number): SegLineT {
  const g = glyphs();
  const f = run.failures.get(row.failureId);
  const grp = run.groups.get(row.groupKey);
  const fixed = row.status === 'fixed';
  const parts: SegLineT = [s(selected ? g.pointer + ' ' : '  ', 'accent', { bold: true })];
  if (row.kind === 'member') parts.push(s('   '));
  parts.push(statusGlyph(row.status), s(' '));
  if (row.kind === 'group' && row.count > 1) {
    parts.push(s((row.expanded ? g.collapse : g.expand) + ' ', 'muted'));
    parts.push(s(grp?.title ?? '', fixed ? 'muted' : undefined, { bold: selected }));
    parts.push(s(` ×${row.count}`, 'pending', { bold: true }));
  } else {
    const name = f ? nameOfTestId(f.id) : row.failureId;
    parts.push(s(name, fixed ? 'muted' : undefined, { bold: selected }));
    if (fixed) parts.push(s(`  ${t('fixedDuringRun')}`, 'fixed'));
    else if (row.status === 'pending') parts.push(s(`  ${t('rerunning')}`, 'pending'));
    else if (row.status === 'still-failing') parts.push(s(`  ${t('stillFailing')}`, 'fail'));
    else if (f && row.kind === 'group') parts.push(s(`  ${(f.file.split('/').pop() ?? f.file)}:${f.line}`, 'muted'));
  }
  const l = truncateLine(parts, width, g.ellipsis);
  return selected ? padLine(l, width, 'selBg').map((x) => ({ ...x, bg: 'selBg' as const })) : l;
}

export function filterLabel(mode: FilterMode): string { return t(`filter_${mode}` as MsgKey); }

export const ListPane = memo(function ListPane(props: {
  run: RunState | null; rows: Row[]; top: number; sel: number; width: number; height: number; focused: boolean;
  filter: FilterMode; text: string; version: number;
}) {
  const { run, rows, top, sel, width, height, focused, filter, text } = props;
  const g = glyphs();
  const inner = width - 4;
  const bodyH = Math.max(1, height - 3);
  const visible = rows.slice(top, top + bodyH);
  const failedCount = run ? [...run.failures.values()].filter((f) => f.fix !== 'fixed').length : 0;
  const title: SegLineT = [
    s(t('failuresTitle'), 'accent', { bold: true }), s(` ${failedCount}`, failedCount ? 'fail' : 'pass', { bold: true }),
    s(`  ${g.dot} ${t('filter')}: ${filterLabel(filter)}${text ? ` "${text}"` : ''}`, 'muted'),
    ...(top > 0 ? [s(`  ${g.arrowUp}${top}`, 'muted')] : []),
    ...(rows.length > top + bodyH ? [s(`  ${g.arrowDown}${rows.length - top - bodyH}`, 'muted')] : []),
  ];
  return (
    <Pane width={width} height={height} focused={focused}>
      <SegLine line={title} width={inner} />
      {!run || rows.length === 0 ? (
        <SegLine
          line={[s(run && run.failures.size ? t('noFailuresFilter') : run?.end ? `${g.pass} ${t('allGreen')}` : t('noFailures'), run?.end && !run.failures.size ? 'pass' : 'muted')]}
          width={inner}
        />
      ) : (
        visible.map((row, i) => <SegLine key={row.key} line={rowLine(run, row, top + i === sel, inner)} width={inner} />)
      )}
    </Pane>
  );
});

export function DetailsPane({ lines, scroll, width, height, focused }: { lines: SegLineT[]; scroll: number; width: number; height: number; focused: boolean }) {
  const g = glyphs();
  const inner = width - 4;
  const bodyH = Math.max(1, height - 3);
  const visible = lines.slice(scroll, scroll + bodyH);
  const title: SegLineT = [
    s(t('detailsTitle'), 'accent', { bold: true }),
    ...(scroll > 0 ? [s(`  ${g.arrowUp}${scroll}`, 'muted')] : []),
    ...(lines.length > scroll + bodyH ? [s(`  ${g.arrowDown}${lines.length - scroll - bodyH}`, 'muted')] : []),
  ];
  return (
    <Pane width={width} height={height} focused={focused}>
      <SegLine line={title} width={inner} />
      {visible.map((l, i) => <SegLine key={scroll + i} line={l} width={inner} />)}
    </Pane>
  );
}

// ------------------------------------------------------------------ footer + help
export function footerLine(opts: { width: number; filter: FilterMode; editing: boolean; draft: string; toast: { text: string; kind: 'ok' | 'err' | 'info' } | null; canRequest: boolean }): SegLineT {
  const g = glyphs();
  if (opts.editing) {
    return [s(' ' + t('filterPrompt'), 'accent', { bold: true }), s(opts.draft), s(getCaps().unicode ? '▏' : '_', 'accent'), s('   ' + t('filterHint'), 'muted')];
  }
  if (opts.toast) {
    const icon = opts.toast.kind === 'err' ? s(' ' + g.fail + ' ', 'fail', { bold: true }) : opts.toast.kind === 'ok' ? s(' ' + g.pass + ' ', 'pass', { bold: true }) : s(' ' + g.dot + ' ', 'accent');
    return [icon, s(opts.toast.text, opts.toast.kind === 'err' ? 'fail' : undefined)];
  }
  const k = (key: string, label: string, dim = false): SegLineT => [s(' ' + key, dim ? 'muted' : 'accent', { bold: true }), s(' ' + label + ' ', 'muted', { dim })];
  // [priority (lower = dropped first), hint]; shown in this order, dropped by priority until it fits
  const hints: Array<[number, SegLineT]> = [
    [1, k(`${g.arrowUp}${g.arrowDown}/jk`, t('k_nav'))],
    [2, k(getCaps().unicode ? '⏎' : 'Enter', t('k_enter'))],
    [8, k('o', t('k_open'))],
    [7, k('r', t('k_rerun'), !opts.canRequest)],
    [5, k('R', t('k_rerunAll'), !opts.canRequest)],
    [8, k('c', t('k_copy'))],
    [4, k('a', t('k_queue'), !opts.canRequest)],
    [6, k('f', `${t('k_filter')}: ${filterLabel(opts.filter)}`)],
    [3, k('/', t('k_search'))],
    [9, k('?', t('k_help'))],
    [9, k('q', t('k_quit'))],
  ];
  let shown = hints;
  for (let p = 1; p < 9 && shown.reduce((w, [, h]) => w + lineWidth(h), 0) > opts.width; p++) shown = shown.filter(([pr]) => pr > p);
  return shown.flatMap(([, h]) => h);
}

export function HelpPane({ width, height }: { width: number; height: number }) {
  const g = glyphs();
  const items: Array<[string, MsgKey]> = [
    [`${g.arrowUp} ${g.arrowDown} / j k`, 'help_nav'],
    ['Enter', 'help_enter'],
    ['Tab', 'help_tab'],
    ['o / O', 'help_open'],
    ['r', 'help_rerun'],
    ['R', 'help_rerunAll'],
    ['c', 'help_copy'],
    ['a', 'help_queue'],
    ['f  /', 'help_filter'],
    ['q', 'help_quit'],
  ];
  const inner = width - 4;
  return (
    <Pane width={width} height={height} focused>
      <SegLine line={[s(t('helpTitle'), 'accent', { bold: true })]} width={inner} />
      <Text> </Text>
      {items.map(([k, m]) => <SegLine key={k} line={[s(k.padEnd(16), 'accent', { bold: true }), s(t(m))]} width={inner} />)}
      <Text> </Text>
      <SegLine line={[s(t('help_oDetail'), 'muted')]} width={inner} />
      <SegLine line={[s(t('help_close'), 'muted')]} width={inner} />
    </Pane>
  );
}
