#!/usr/bin/env node
// vto savings estimate – what vto would save a team, before anything is installed.
// A transparent model, every input a flag; the measured counterpart is `vto savings measured`
// (mcp/SAVINGS.md). No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { summary, table, painter, colorEnabled } from '../vitest-guard/src/ui.mjs';
import { sanitize } from '../vitest-guard/src/safety.mjs';

const HELP = `vto savings estimate – projected monthly savings of vto (affected tests + fast pools)

Usage: vto savings estimate --suite-min MIN [options] [--json]

Suite
  --suite-min MIN        wall time of one full test run in CI, minutes (required)
  --selected SHARE       share of the suite an affected run executes          (default 0.2)
  --run-all SHARE        share of runs that fall back to the full suite        (default 0.2)
  --overhead MIN         fixed cost of an affected run: map download, selection (default 0.5)
  --pool-gain SHARE      time saved by a fast pool, from \`vto guard compare\`   (default 0)
CI
  --ci-runs N            pipeline runs with tests per working day              (default 20)
  --shards N             parallel jobs the suite is split into                 (default 1)
  --usd-per-min USD      runner price per minute (default 0.006: GitHub-hosted Linux 2-core x64,
                         list price since 1 Jan 2026; Windows 0.010, macOS 0.062; self-hosted: your cost)
Developers
  --devs N               developers running tests locally                      (default 5)
  --local-runs N         local test runs per developer per working day         (default 10)
  --usd-per-hour USD     loaded cost of a developer hour, to price waiting     (default: not priced)
AI agents (optional)
  --agent-runs N         test runs by AI agents per working day                (default 0)
  --classic-tokens N     tokens of one full Vitest output read by the agent    (default 20000)
  --vto-tokens N         tokens of a vto answer (MCP budget 8 KB)              (default 1500)
  --usd-per-mtok USD     input price per million tokens                        (default: not priced)
Measured inputs
  --from-measured [DIR]  take suite time, selection share, run-all share, pool gain and local runs per day
                         from DIR/.vto/metrics.jsonl (default: the current directory); explicit flags win
  --since 30d            period of the measured runs                           (default 30d)
Other
  --days N               working days per month                                (default 21)
  --json                 machine-readable result

Model: full = suite × (1 − pool-gain); affected = full × selected + overhead;
expected run = run-all × full + (1 − run-all) × affected; saved per run = suite − expected.
Every figure is an estimate from these inputs. Measure the real selection share and pool gain on your
suite (\`vto run\`, \`vto guard compare\`) and the realised savings with \`vto savings measured\`.`;

const SPEC = {
  'suite-min': { req: true }, selected: { def: 0.2, share: true }, 'run-all': { def: 0.2, share: true }, overhead: { def: 0.5 },
  'pool-gain': { def: 0, share: true }, 'ci-runs': { def: 20 }, shards: { def: 1, int: true }, 'usd-per-min': { def: 0.006 },
  devs: { def: 5, int: true }, 'local-runs': { def: 10 }, 'usd-per-hour': { def: null }, 'agent-runs': { def: 0 },
  'classic-tokens': { def: 20000 }, 'vto-tokens': { def: 1500 }, 'usd-per-mtok': { def: null }, days: { def: 21 },
};

export function parse(argv) {
  const o = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { o.json = true; continue; }
    if (a === '--help' || a === '-h') { o.help = true; continue; }
    if (a === '--from-measured') { o.fromMeasured = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '.'; continue; }
    if (a.startsWith('--from-measured=')) { o.fromMeasured = a.slice(16) || '.'; continue; }
    if (a === '--since' || a.startsWith('--since=')) { const v = a.includes('=') ? a.slice(8) : argv[++i]; if (!/^\d+[dhm]$/.test(v || '')) throw new Error(`--since needs e.g. 30d, 12h, got ${JSON.stringify(String(v))}`); o.since = v; continue; }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m || !SPEC[m[1]]) throw new Error(`unknown option ${JSON.stringify(a.slice(0, 40))}`);
    const raw = m[2] ?? argv[++i];
    const v = Number(raw);
    if (raw === undefined || raw === '' || !Number.isFinite(v) || v < 0) throw new Error(`--${m[1]} needs a non-negative number, got ${JSON.stringify(String(raw))}`);
    if (SPEC[m[1]].share && v > 1) throw new Error(`--${m[1]} is a share between 0 and 1 (0.2 = 20 %), got ${raw}`);
    if (SPEC[m[1]].int && !Number.isInteger(v)) throw new Error(`--${m[1]} must be a whole number, got ${raw}`);
    o[m[1]] = v;
  }
  o.given = new Set(Object.keys(SPEC).filter((k) => o[k] !== undefined));
  if (o.fromMeasured !== undefined && !o.help) applyMeasured(o, readMeasured(o.fromMeasured, o.since || '30d'));
  o.sources ||= {};
  for (const [k, s] of Object.entries(SPEC)) if (o[k] === undefined) {
    if (s.req && !o.help) throw new Error(`--${k} is required${o.fromMeasured !== undefined ? ' (no full run in the measured data)' : ''}`);
    o[k] = s.def;
  }
  return o;
}

const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };

/** aggregate .vto/metrics.jsonl (written by the daemon / vto run; mcp/src/metrics.mjs) */
export function measuredFrom(records, { since = '30d', now = Date.now() } = {}) {
  const m = /^(\d+)([dhm])$/.exec(since); const ms = +m[1] * (m[2] === 'd' ? 864e5 : m[2] === 'h' ? 36e5 : 6e4);
  const runs = records.filter((r) => r?.t === 'run' && r.status === 'done' && r.suiteTotal > 0 && Date.parse(r.at) >= now - ms);
  const full = runs.filter((r) => r.kind === 'full' && r.testsRun >= 0.95 * r.suiteTotal && r.wallMs > 0);
  const affected = runs.filter((r) => r.kind === 'affected');
  const fellBack = affected.filter((r) => r.testsRun >= 0.95 * r.suiteTotal);
  const partial = affected.filter((r) => r.testsRun < 0.95 * r.suiteTotal);
  const isGuard = (p) => /vitest-guard:(vm|shared)/.test(String(p || ''));
  const fullOf = (pred) => median(full.filter((r) => pred(r.pool)).map((r) => r.wallMs));
  const forks = fullOf((p) => p === 'forks' || p === 'threads'), fast = fullOf(isGuard);
  const latestFull = full.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  const local = runs.filter((r) => !r.ci);
  const days = new Set(local.map((r) => String(r.at).slice(0, 10))).size;
  return {
    runs: runs.length, since,
    suiteMin: latestFull ? latestFull.wallMs / 60000 : null, suitePool: latestFull?.pool ?? null,
    selected: partial.length ? median(partial.map((r) => r.testsRun / r.suiteTotal)) : null, partialRuns: partial.length,
    runAll: affected.length ? fellBack.length / affected.length : null, affectedRuns: affected.length,
    poolGain: forks && fast && fast < forks ? 1 - fast / forks : null,
    localRunsPerDay: days ? local.length / days : null, localDays: days,
  };
}

function readMeasured(dir, since) {
  const file = path.join(path.resolve(dir), '.vto', 'metrics.jsonl');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { throw new Error(`no measured runs: ${file} does not exist (run tests with \`vto run\` first)`); }
  const recs = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const m = measuredFrom(recs, { since });
  // a committed .vto/metrics.jsonl is untrusted: its pool label must not drive the terminal (security review 3 S3)
  if (m.suitePool != null) m.suitePool = sanitize(String(m.suitePool), 80);
  if (!m.runs) throw new Error(`no finished runs in ${file} within ${since}`);
  return m;
}

function applyMeasured(o, m) {
  o.sources = {}; o.measured = m;
  const set = (k, v, note) => { if (v == null || o.given.has(k)) return; o[k] = Math.round(v * 1000) / 1000; o.sources[k] = note; };
  // a full run measured in a fast pool is already faster: the pool gain is in the suite time then, not on top
  if (m.suitePool && /vitest-guard:(vm|shared)/.test(m.suitePool)) set('suite-min', m.suiteMin / (1 - (m.poolGain ?? 0)), `measured (full run, ${m.suitePool}${m.poolGain ? ', converted to forks' : ''})`);
  else set('suite-min', m.suiteMin, `measured (latest full run${m.suitePool ? ', ' + m.suitePool : ''})`);
  set('selected', m.selected, `measured (median of ${m.partialRuns} affected runs)`);
  set('run-all', m.runAll, `measured (${m.affectedRuns} affected runs)`);
  set('pool-gain', m.poolGain, 'measured (full runs: forks vs vitest-guard)');
  set('local-runs', m.localRunsPerDay, `measured on this machine (${m.localDays} days)`);
}

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

export function estimate(o) {
  const full = o['suite-min'] * (1 - o['pool-gain']);
  const affected = Math.min(full, full * o.selected + o.overhead);
  const expected = o['run-all'] * full + (1 - o['run-all']) * affected;
  const savedPerRun = Math.max(0, o['suite-min'] - expected);
  // GitHub bills each job rounded up to whole minutes
  const billed = (min) => Math.ceil(min / o.shards) * o.shards;
  const billedBefore = billed(o['suite-min']);
  const billedAfter = o['run-all'] * billed(full) + (1 - o['run-all']) * billed(affected);
  const ciRunsMonth = o['ci-runs'] * o.days;
  const ciMinutes = Math.max(0, billedBefore - billedAfter) * ciRunsMonth;
  const localRunsMonth = o.devs * o['local-runs'] * o.days;
  const waitHours = (savedPerRun * localRunsMonth) / 60;
  const agentRunsMonth = o['agent-runs'] * o.days;
  const tokens = Math.max(0, o['classic-tokens'] - o['vto-tokens']) * agentRunsMonth;
  return {
    inputs: o,
    perRun: { before: r2(o['suite-min']), after: r2(expected), savedMin: r2(savedPerRun), share: o['suite-min'] ? r2(savedPerRun / o['suite-min']) : 0 },
    month: {
      ciRuns: ciRunsMonth, ciRunnerMinutes: Math.round(ciMinutes), ciUsd: r2(ciMinutes * o['usd-per-min']),
      localRuns: localRunsMonth, devWaitHours: r1(waitHours), devUsd: o['usd-per-hour'] == null ? null : Math.round(waitHours * o['usd-per-hour']),
      agentRuns: agentRunsMonth, tokens: Math.round(tokens), tokenUsd: o['usd-per-mtok'] == null ? null : r2((tokens / 1e6) * o['usd-per-mtok']),
    },
  };
}

const n0 = (x) => Math.round(x).toLocaleString('en-US');
const usd = (x) => '$' + (x >= 100 ? n0(x) : x.toFixed(2));

export function main(argv = process.argv.slice(2)) {
  let o;
  try { o = parse(argv); } catch (e) { console.error(`vto savings estimate: ${e.message}\nsee --help`); return 2; }
  if (o.help) { console.log(HELP); return 0; }
  const e = estimate(o);
  if (o.json) { console.log(JSON.stringify(e, null, 2)); return 0; }
  const p = painter(colorEnabled());
  const m = e.month;
  const rows = [
    ['CI', `${n0(m.ciRuns)} runs`, `${n0(m.ciRunnerMinutes)} runner min`, p.green(usd(m.ciUsd))],
    ['developers', `${n0(m.localRuns)} runs`, `${m.devWaitHours} h less waiting`, m.devUsd == null ? p.dim('(--usd-per-hour)') : p.green(usd(m.devUsd))],
  ];
  if (m.agentRuns) rows.push(['AI agents', `${n0(m.agentRuns)} runs`, `${(m.tokens / 1e6).toFixed(1)} M tokens`, m.tokenUsd == null ? p.dim('(--usd-per-mtok)') : p.green(usd(m.tokenUsd))]);
  summary({
    tool: 'vto', title: o.fromMeasured !== undefined ? 'savings estimate · from measured runs' : 'savings estimate',
    verdict: 'ok', label: 'ESTIMATE',
    headline: `a test run drops from ${e.perRun.before} to ${e.perRun.after} min on average (−${Math.round(e.perRun.share * 100)} %)`,
    facts: [
      ['suite', `${r2(o['suite-min'])} min full run`],
      ['selected', `${Math.round(o.selected * 100)} % of the suite per affected run`],
      ['run all', `${Math.round(o['run-all'] * 100)} % of runs`],
      ['fast pool', o['pool-gain'] ? `−${Math.round(o['pool-gain'] * 100)} %` : 'not counted (measure: vto guard compare)'],
      ['local runs', `${r1(o['local-runs'])} per developer per day, ${o.devs} developer${o.devs === 1 ? '' : 's'}`],
      ['runner price', `$${o['usd-per-min']}/min${o.shards > 1 ? `, ${o.shards} shards` : ''}`],
    ].map(([k, v]) => {
      const key = { suite: 'suite-min', selected: 'selected', 'run all': 'run-all', 'fast pool': 'pool-gain', 'local runs': 'local-runs' }[k];
      const src = key && o.sources?.[key];
      if (key === 'pool-gain' && !o['pool-gain'] && !src) return [k, v];
      return [k, src ? `${v}  ${p.green('· ' + src)}` : key && !o.given?.has(key) && o.fromMeasured === undefined ? `${v}  ${p.dim('· assumed')}` : key && !o.given?.has(key) ? `${v}  ${p.yellow('· assumed (not in the measured data)')}` : v];
    }),
    tableLines: table(['per month', 'runs', 'saved', 'value'], rows, ['l', 'r', 'r', 'r'], p),
    next: o.fromMeasured !== undefined
      ? [`extrapolated from ${o.measured.runs} measured runs (${o.measured.since}); team size and CI runs per day are inputs, not measured`, 'realised savings so far: `vto savings measured`']
      : ['an estimate from the inputs above: use your own numbers with `--from-measured` after a few days of `vto run`', 'realised savings over time: `vto savings measured`'],
  });
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('savings-estimate.mjs')) process.exitCode = main();
