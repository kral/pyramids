import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, useApp, useInput, useWindowSize } from 'ink';
import type { RunStore } from '../model.js';
import type { EventSource } from '../sources/types.js';
import { SourceCache } from '../codeframe.js';
import { buildRows, headerModel, resolveSelection, scrollWindow, type FilterMode } from '../view.js';
import { t } from '../i18n.js';
import { buildPrompt, buildTask } from '../prompt.js';
import { DetailsPane, HelpPane, ListPane, SegLine, footerLine, headerLines } from './components.js';
import { detailsLines, openTarget } from './detailsLines.js';
import type { SegLineT } from './segments.js';

export interface OpenRequest { file: string; line: number; col?: number }
export interface Actions {
  /** returns the editor name; `suspend` hands the terminal to a TUI editor (vim, nano…) */
  openEditor(target: OpenRequest, suspend: (fn: () => Promise<void>) => Promise<void>): Promise<string>;
  /** returns the method used */
  copy(text: string): Promise<string>;
}

export interface AppProps {
  store: RunStore;
  source: EventSource;
  root: string;
  actions: Actions;
  /** min ms between React updates caused by events (batching) */
  batchMs?: number;
  /** disable timers (snapshot tests) */
  staticClock?: number;
  sourceStatus?: () => string;
  onQuit?: () => void;
  /** fixed size for tests (otherwise the terminal size) */
  size?: { columns: number; rows: number };
}

type Toast = { text: string; kind: 'ok' | 'err' | 'info' } | null;

function useBatchedVersion(store: RunStore, batchMs: number): number {
  const [v, setV] = useState(store.version);
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;
    let last = 0;
    const un = store.subscribe(() => {
      if (timer) return;
      const wait = Math.max(0, batchMs - (performance.now() - last));
      timer = setTimeout(() => { timer = null; last = performance.now(); setV(store.version); }, wait);
    });
    setV(store.version);
    return () => { un(); if (timer) clearTimeout(timer); };
  }, [store, batchMs]);
  return v;
}

const FILTERS: FilterMode[] = ['all', 'failed', 'fixed'];

export function App(props: AppProps) {
  const { store, source, root, actions } = props;
  const app = useApp();
  const win = useWindowSize();
  const columns = props.size?.columns ?? win.columns ?? 100;
  const rowsN = props.size?.rows ?? win.rows ?? 30;
  const version = useBatchedVersion(store, props.batchMs ?? 33);
  const cache = useMemo(() => new SourceCache(root), [root]);

  const [mode, setMode] = useState<FilterMode>('all');
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selKey, setSelKey] = useState<string | null>(null);
  const prevIndex = useRef(0);
  const topRef = useRef(0);
  const [focus, setFocus] = useState<'list' | 'details'>('list');
  const [zoom, setZoom] = useState(false);
  const [help, setHelp] = useState(false);
  const [detailScroll, setDetailScroll] = useState(0);
  const [toast, setToastState] = useState<Toast>(null);
  const toastTimer = useRef<NodeJS.Timeout | null>(null);
  const [tick, setTick] = useState(0);

  const run = store.current;
  const lastRunId = useRef<string | null>(null);

  const setToast = useCallback((tt: Toast, ms = 3500) => {
    setToastState(tt);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    if (tt) toastTimer.current = setTimeout(() => setToastState(null), ms);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // spinner + ETA countdown while the run is active (4 fps; Ink coalesces with event renders)
  const active = !run || !run.end;
  useEffect(() => {
    if (props.staticClock !== undefined || !active) return;
    const id = setInterval(() => setTick((x) => x + 1), 250);
    return () => clearInterval(id);
  }, [active, props.staticClock]);

  // new run → notify; selection resets naturally (keys differ)
  useEffect(() => {
    if (run && lastRunId.current && lastRunId.current !== run.runId) setToast({ text: t('t_newRun', { runId: run.runId }), kind: 'info' });
    if (run) lastRunId.current = run.runId;
  }, [run?.runId, setToast]);

  const rows = useMemo(() => buildRows(run, { mode, text }, expanded), [run, version, mode, text, expanded]);
  const sel = resolveSelection(rows, selKey, prevIndex.current);
  prevIndex.current = Math.max(0, sel);
  const selRow = sel >= 0 ? rows[sel] : undefined;
  const selFailure = run && selRow ? run.failures.get(selRow.failureId) : undefined;

  // ------------------------------------------------------------ layout
  const now = props.staticClock ?? Date.now();
  const hm = headerModel(run, now);
  const hLines = headerLines(hm, columns - 1, tick, source.label, props.sourceStatus?.() ?? '');
  const footerH = 1;
  const bodyH = Math.max(6, rowsN - hLines.length - footerH);
  const wide = columns >= 110;
  let listW = columns, listH = bodyH, detW = columns, detH = bodyH;
  if (zoom) { listH = 0; }
  else if (wide) { listW = Math.max(36, Math.floor(columns * 0.42)); detW = columns - listW; }
  else { listH = Math.max(5, Math.floor(bodyH * 0.4)); detH = bodyH - listH; }
  const listBody = Math.max(1, listH - 3);
  const top = scrollWindow(Math.max(0, sel), topRef.current, listBody, rows.length);
  topRef.current = top;

  const dLines: SegLineT[] = useMemo(
    () => (run && selFailure ? detailsLines(run, selFailure, cache, detW - 4) : []),
    // re-evaluated when the failure changes state (fix) or new group members arrive
    [run, selFailure, selFailure?.fix, version, detW, cache],
  );
  const detBody = Math.max(1, detH - 3);
  const maxScroll = Math.max(0, dLines.length - detBody);
  const dScroll = Math.min(detailScroll, maxScroll);
  useEffect(() => { setDetailScroll(0); }, [selRow?.failureId]);

  // ------------------------------------------------------------ actions
  const move = (delta: number) => {
    if (!rows.length) return;
    const i = Math.max(0, Math.min(rows.length - 1, (sel < 0 ? 0 : sel) + delta));
    prevIndex.current = i;
    setSelKey(rows[i].key);
  };
  const groupIds = (): string[] => {
    if (!run || !selRow) return [];
    if (selRow.kind === 'member') return [selRow.failureId];
    const g = run.groups.get(selRow.groupKey);
    return (g?.ids ?? []).filter((id) => run.failures.get(id)?.fix !== 'fixed');
  };
  const rerun = async (ids: string[] | undefined) => {
    if (!run) return;
    if (!source.canRequest) { setToast({ text: t('t_readOnly'), kind: 'err' }); return; }
    const list = ids ?? [...run.failures.values()].filter((f) => f.fix !== 'fixed').map((f) => f.id);
    if (!list.length) { setToast({ text: t('t_nothingToRerun'), kind: 'info' }); return; }
    store.markPending(run.runId, list);
    setToast({ text: t('t_rerunSent', { n: list.length }), kind: 'info' });
    try {
      const res = (await source.request({ method: 'rerun_failed', params: { runId: run.runId, ...(ids ? { ids: ids.map((id) => run.failures.get(id)?.rawId ?? id) } : {}) } })) as { runId?: string; status?: string } | undefined;
      // the real daemon answers with a new run (kind "failed") that the store overlays on this one
      if (res?.runId && res.runId !== run.runId) setToast({ text: t('t_rerunQueued', { n: list.length, runId: res.runId }), kind: 'info' }, 5000);
    } catch (e) {
      store.clearPending(run.runId, list);
      setToast({ text: t('t_rerunFailed', { err: (e as Error).message }), kind: 'err' });
    }
  };
  const open = async (which: 'fix' | 'test') => {
    if (!selFailure) return;
    const target = openTarget(selFailure, which);
    try {
      const name = await actions.openEditor(target, async (fn) => { await app.suspendTerminal(fn); });
      setToast({ text: t('t_opened', { file: target.file, line: target.line, editor: name }), kind: 'ok' });
    } catch (e) {
      const msg = (e as Error).message;
      const loc = (e as { location?: unknown }).location;
      if (msg === 'no-editor' && typeof loc === 'string') {
        // never hand the file to the OS default handler: show where it is and put the path on the clipboard
        try { const m = await actions.copy(loc); setToast({ text: t('t_noEditorCopied', { path: loc, method: m }), kind: 'info' }, 10000); }
        catch { setToast({ text: t('t_noEditorPath', { path: loc }), kind: 'info' }, 10000); }
      } else setToast({ text: msg === 'no-editor' ? t('t_noEditor') : t('t_openFailed', { err: msg }), kind: 'err' }, 6000);
    }
  };
  const copy = async () => {
    if (!run || !selRow) return;
    const text = buildPrompt(run, selRow.groupKey, cache, selRow.failureId);
    try { const m = await actions.copy(text); setToast({ text: t('t_copied', { method: m }), kind: 'ok' }); }
    catch (e) { setToast({ text: t('t_copyFailed', { err: (e as Error).message }), kind: 'err' }, 6000); }
  };
  const enqueue = async () => {
    if (!run || !selRow) return;
    if (!source.canRequest) { setToast({ text: t('t_readOnly'), kind: 'err' }); return; }
    const task = buildTask(run, selRow.groupKey);
    if (!task) { setToast({ text: t('t_nothingToRerun'), kind: 'info' }); return; }
    try { await source.request({ method: 'enqueue_task', params: { task } }); setToast({ text: t('t_queued', { n: task.count }), kind: 'ok' }); }
    catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === 'E_METHOD' || /unknown method|not mocked|E_METHOD/i.test(err.message)) {
        // daemon without a task queue (vto-ipc/1 has none yet): hand the task over via the clipboard
        try { const m = await actions.copy(JSON.stringify(task, null, 2)); setToast({ text: t('t_queueFallback', { method: m }), kind: 'info' }, 6000); }
        catch (e2) { setToast({ text: t('t_copyFailed', { err: (e2 as Error).message }), kind: 'err' }); }
      } else setToast({ text: t('t_rerunFailed', { err: err.message }), kind: 'err' });
    }
  };
  const quit = () => { props.onQuit?.(); app.exit(); };

  useInput((input, key) => {
    if (help) { setHelp(false); return; }
    if (editing) {
      if (key.return) { setEditing(false); setText(draft); return; }
      if (key.escape) { setEditing(false); setDraft(text); return; }
      if (key.backspace || key.delete) { setDraft((d) => d.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setDraft((d) => d + input);
      return;
    }
    if (key.ctrl && input === 'c') { quit(); return; }
    const inDetails = focus === 'details' || zoom;
    const page = inDetails ? detBody : listBody;
    if (key.upArrow || input === 'k') { inDetails ? setDetailScroll((x) => Math.max(0, Math.min(x, maxScroll) - 1)) : move(-1); return; }
    if (key.downArrow || input === 'j') { inDetails ? setDetailScroll((x) => Math.min(maxScroll, x + 1)) : move(1); return; }
    if (key.pageUp) { inDetails ? setDetailScroll((x) => Math.max(0, Math.min(x, maxScroll) - page)) : move(-page); return; }
    if (key.pageDown || input === ' ') { inDetails ? setDetailScroll((x) => Math.min(maxScroll, x + page)) : move(page); return; }
    if (key.home || input === 'g') { inDetails ? setDetailScroll(0) : move(-1e9); return; }
    if (key.end || input === 'G') { inDetails ? setDetailScroll(maxScroll) : move(1e9); return; }
    if (key.tab) { setFocus((f) => (f === 'list' ? 'details' : 'list')); return; }
    if (key.return) {
      if (selRow && selRow.kind === 'group' && selRow.count > 1) {
        setExpanded((e) => { const n = new Set(e); n.has(selRow.groupKey) ? n.delete(selRow.groupKey) : n.add(selRow.groupKey); return n; });
      } else setZoom((z) => !z);
      return;
    }
    if (key.escape) { if (zoom) setZoom(false); else if (text) { setText(''); setDraft(''); } else if (focus === 'details') setFocus('list'); return; }
    switch (input) {
      case 'q': quit(); return;
      case '?': case 'h': setHelp(true); return;
      case 'o': void open('fix'); return;
      case 'O': void open('test'); return;
      case 'r': void rerun(groupIds()); return;
      case 'R': void rerun(undefined); return;
      case 'c': void copy(); return;
      case 'a': void enqueue(); return;
      case 'f': setMode((m) => FILTERS[(FILTERS.indexOf(m) + 1) % FILTERS.length]); return;
      case '/': setDraft(text); setEditing(true); return;
      case 'z': setZoom((z) => !z); return;
    }
  });

  // ------------------------------------------------------------ render
  const fLine = footerLine({ width: columns, filter: mode, editing, draft, toast, canRequest: source.canRequest });
  return (
    <Box flexDirection="column" width={columns} height={rowsN}>
      {hLines.map((l, i) => <SegLine key={'h' + i} line={l} width={columns - 1} />)}
      {help ? (
        <HelpPane width={columns} height={bodyH} />
      ) : (
        <Box flexDirection={wide || zoom ? 'row' : 'column'} height={bodyH}>
          {!zoom && (
            <ListPane run={run} rows={rows} top={top} sel={sel} width={listW} height={listH} focused={focus === 'list'} filter={mode} text={text} version={version} />
          )}
          <DetailsPane lines={dLines} scroll={dScroll} width={zoom ? columns : detW} height={detH} focused={focus === 'details' || zoom} />
        </Box>
      )}
      <SegLine line={fLine} width={columns - 1} />
    </Box>
  );
}
