// Non-TTY / CI mode: plain streaming output. Each failure is printed the moment it arrives
// (compact), fixes during the run are reported, periodic progress lines, summary + exit code.
//   exit 0 – run ended, no failure left (failures fixed during the run do not count)
//   exit 1 – run ended with failures
//   exit 2 – source ended/errored before run-end
import chalk from 'chalk';
import type { VtoEvent } from './events.js';
import { nameOfTestId } from './events.js';
import { classifyDiff } from './diff.js';
import { t } from './i18n.js';
import { RunStore, failingLocation, projectFrame } from './model.js';
import { getCaps, glyphs } from './term.js';
import { formatMs } from './view.js';
import { ciSafe } from './sanitize.js';
import type { MsgKey } from './i18n.js';

export function kindLabel(kind: string): string {
  return ['affected', 'full', 'tests', 'failed'].includes(kind) ? t(`kind_${kind}` as MsgKey) : kind;
}

export interface CiOptions {
  write: (s: string) => void;
  progressIntervalMs?: number;
  now?: () => number;
  /** follow this run only (default: the first run-start seen) */
  runId?: string;
}

export class CiPrinter {
  readonly store = new RunStore();
  private runId: string | null;
  private printedGroups = new Map<string, number>();
  private lastProgress = 0;
  private n = 0;
  done = false;
  exitCode = 2;

  constructor(private o: CiOptions) { this.runId = o.runId ?? null; }

  // every line may carry untrusted text: no workflow command (`::error::`, `##vso[…]`) survives
  private w(line = '') { this.o.write(ciSafe(line) + '\n'); }
  private now() { return (this.o.now ?? Date.now)(); }

  onEvents(evs: VtoEvent[]): void {
    for (const ev of evs) {
      if (this.done) return;
      if (!this.runId && ev.ev === 'run-start') this.runId = ev.runId;
      if (this.runId && ev.runId !== this.runId) continue;
      this.store.applyMany([ev]);
      this.print(ev);
    }
  }

  private print(ev: VtoEvent) {
    const g = glyphs();
    switch (ev.ev) {
      case 'run-start':
        this.lastProgress = this.now();
        this.w(chalk.bold(t('ci_start', { runId: ev.runId, kind: kindLabel(ev.kind), total: ev.total, files: ev.files, pool: ev.pool ?? '-' })));
        return;
      case 'failure': {
        this.n++;
        const grp = ev.group ?? this.store.current?.failures.get(ev.id)?.groupKey ?? '';
        const first = this.printedGroups.get(grp);
        if (first !== undefined) {
          this.w(`${chalk.red(g.fail)} ${ev.id}  ${chalk.dim(`(${t('sameErrorIn', { n: (this.store.current?.groups.get(grp)?.ids.length ?? 2) })}, #${first})`)}`);
          return;
        }
        this.printedGroups.set(grp, this.n);
        this.w(`${chalk.red.bold(g.fail)} ${chalk.bold(ev.id)}  ${chalk.dim('#' + this.n)}`);
        for (const l of ev.message.split('\n').slice(0, 3)) this.w('    ' + chalk.red((getCaps().unicode ? '\u2502 ' : '| ') + l));
        const loc = failingLocation(ev);
        const fr = projectFrame(ev);
        this.w(chalk.dim(`    at ${loc.file}:${loc.line}${loc.col ? ':' + loc.col : ''}`));
        if (fr) this.w(chalk.dim(`    at ${fr.file}:${fr.line}${fr.col ? ':' + fr.col : ''}`) + (fr.code ? '  ' + fr.code.trim().slice(0, 100) : ''));
        if (ev.diff) {
          const d = classifyDiff(ev.diff, 16);
          for (const l of d.lines) {
            if (l.kind === 'header' || (l.kind === 'context' && !l.text.trim())) continue;
            const txt = l.text.replace(/\u00a0/g, getCaps().unicode ? '\u2423' : '_');
            this.w('    ' + (l.kind === 'expected' ? chalk.green(txt) : l.kind === 'received' ? chalk.red(txt) : chalk.dim(txt)));
          }
        }
        return;
      }
      case 'fix-rerun':
        if (ev.state === 'pass') this.w(`${chalk.green.bold(g.fixed)} ${t('fixedDuringRun')}: ${nameOfTestId(ev.id)}`);
        else this.w(`${chalk.yellow(g.still)} ${t('stillFailing')}: ${nameOfTestId(ev.id)}`);
        return;
      case 'progress':
      case 'test': {
        const iv = this.o.progressIntervalMs ?? 10_000;
        if (iv > 0 && this.now() - this.lastProgress >= iv) {
          this.lastProgress = this.now();
          const r = this.store.current!;
          this.w(chalk.dim(t('ci_progress', { done: Math.max(r.passed + r.failed + r.skipped, r.progressDone), total: r.total, failed: r.failed })));
        }
        return;
      }
      case 'run-end': {
        this.done = true;
        const r = this.store.current!;
        const fixed = [...r.failures.values()].filter((f) => f.fix === 'fixed').length;
        const remaining = Math.max(0, ev.failed - fixed);
        this.w('');
        this.w(chalk.bold(t('ci_summary', { passed: ev.passed, failed: ev.failed, skipped: ev.skipped, ms: formatMs(ev.ms) })));
        if (fixed) this.w(chalk.green(`${g.fixed} ${t('ci_fixed', { n: fixed })}`));
        if (r.groupOrder.length) {
          this.w(t('ci_groups'));
          for (const k of r.groupOrder) {
            const grp = r.groups.get(k)!;
            const left = grp.ids.filter((id) => r.failures.get(id)?.fix !== 'fixed').length;
            const f = r.failures.get(grp.ids[0])!;
            const mark = left ? chalk.red(g.fail) : chalk.green(g.fixed);
            this.w(`  ${mark} ×${grp.ids.length} ${grp.title.slice(0, 120)}  ${chalk.dim(`${f.file}:${f.line}`)}`);
          }
        }
        this.w(remaining ? chalk.red.bold(`${g.fail} ${t('ci_remaining', { n: remaining })}`) : chalk.green.bold(`${g.pass} ${t('allGreen')}`));
        this.exitCode = remaining ? 1 : 0;
        return;
      }
      default:
        return;
    }
  }

  /** source ended without run-end */
  sourceEnded(): void {
    if (this.done) return;
    this.done = true;
    this.w(chalk.yellow(t('ci_noEnd')));
    this.exitCode = 2;
  }
}
