#!/usr/bin/env node
// Differential test harness for the vto v2 instrumenter (see ../../FORMAT.md, "How the collector produces hits").
//
//   node run.mjs [--plugin <path>] [--only a,b] [--setup <setupFile>] [--keep] [--verbose] [--json <file>]
//
// For every module in ./cases it
//   (a) runs the module's `scenario()` under Vitest + jsdom WITHOUT the plugin,
//   (b) runs it again WITH the plugin, and compares serialized results/exports/console output,
// and additionally checks, per instrumented module:
//   - the instrumented output (plugin transform result) parses (oxc-parser), directives preserved,
//   - every block position lies inside the original source, on a token boundary
//     (not inside a string/comment/identifier, not splitting a surrogate pair or CRLF),
//   - marker indices in the output are exactly 0..blocks-1 and match the registry array length,
//   - coverage sanity: code annotated `/*@never*/` (never executed by the scenario) is not marked
//     hit; code annotated `/*@hit*/` (always executed) is marked hit.
// Exit code: 0 all pass / plugin missing (skip), 1 failures, 2 harness error.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES = path.join(HERE, 'cases');
// Vite ids use '/' on every platform (D:/a/…/cases/x.ts on Windows); compare in that spelling
const slashed = (p) => p.replace(/\\/g, '/');
const inCases = (id) => slashed(id).startsWith(slashed(CASES) + '/');
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const flag = (name) => argv.includes('--' + name);

// ------------------------------------------------------------------------------------------
// plugin loading / wrapping (used by the child)
// ------------------------------------------------------------------------------------------
async function loadPlugin(p) {
  const mod = await import(pathToFileURL(path.resolve(p)).href);
  let cand = mod.default ?? mod.vto ?? mod.vtoPlugin ?? mod.plugin ?? mod.instrument;
  if (cand === undefined) {
    const fns = Object.values(mod).filter((x) => typeof x === 'function' || (x && typeof x === 'object' && x.name));
    cand = fns[0];
  }
  if (typeof cand === 'function') cand = await cand({});
  const plugins = (Array.isArray(cand) ? cand.flat(Infinity) : [cand]).filter(Boolean);
  if (!plugins.length || !plugins.every((x) => typeof x === 'object')) throw new Error('plugin module did not yield a Vite plugin object');
  return plugins;
}

function hookFn(h) {
  return typeof h === 'function' ? h : h && typeof h.handler === 'function' ? h.handler : null;
}

function wrapTransform(plugin, captures, all, sink) {
  const h = plugin.transform;
  const fn = hookFn(h);
  if (!fn) return plugin;
  const wrapped = async function (code, id, ...rest) {
    const res = await fn.call(this, code, id, ...rest);
    const clean = path.resolve(id.replace(/[?#].*$/, '')); // the key lookups use (path.join(CASES, f))
    if (inCases(clean)) {
      const out = res == null ? null : typeof res === 'string' ? res : res.code ?? null;
      const meta = res && typeof res === 'object' ? res.meta ?? null : null;
      captures[clean] = { id, input: code, output: out, meta, blocks: res && typeof res === 'object' && Array.isArray(res.blocks) ? res.blocks : undefined, extra: res && typeof res === 'object' ? Object.keys(res) : [] };
      // persisted immediately: the child may be killed later if a scenario hangs
      appendFileSync(sink, JSON.stringify({ file: clean, cap: captures[clean], blocks: apiBlocks(all, id, captures[clean]) }) + '\n');
    }
    return res;
  };
  return { ...plugin, transform: typeof h === 'function' ? wrapped : { ...h, handler: wrapped } };
}

function apiBlocks(plugins, id, cap) {
  const tries = [];
  if (cap?.meta) tries.push(() => cap.meta.vto?.blocks ?? cap.meta.blocks);
  if (cap?.blocks) tries.push(() => cap.blocks);
  for (const p of plugins) {
    const a = p.api;
    if (!a) continue;
    tries.push(
      () => a.getBlocks?.(id),
      () => (typeof a.blocks === 'function' ? a.blocks(id) : a.blocks?.get?.(id) ?? a.blocks?.[id]),
      () => a.files?.get?.(id)?.blocks ?? a.files?.[id]?.blocks,
      () => a.getFile?.(id)?.blocks,
    );
  }
  for (const t of tries) {
    try {
      const b = t();
      if (Array.isArray(b)) return b;
    } catch {}
  }
  return null;
}

// Vite 8 (oxc) does not lower TS 5 standard decorators / `accessor` fields and Node 22 cannot run
// them. For cases that use them, a pre plugin placed AFTER the instrumenter lowers them with the
// TypeScript 5 compiler (target ES2022) - identically in both modes, so the comparison stays fair.
const LOWER = /(decorator|accessor)/;
function tsLowerPlugin() {
  let ts;
  return {
    name: 'vto-corpus-ts-lower',
    enforce: 'pre',
    async transform(code, id) {
      const clean = id.replace(/[?#].*$/, '');
      if (!inCases(clean) || !LOWER.test(path.basename(clean))) return null;
      ts ??= (await import('typescript')).default;
      const r = ts.transpileModule(code, {
        fileName: clean,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, useDefineForClassFields: true, jsx: ts.JsxEmit.Preserve, experimentalDecorators: false, sourceMap: false },
      });
      return { code: r.outputText, map: null };
    },
  };
}

async function child(mode) {
  const out = opt('out');
  const cwd = HERE;
  process.chdir(cwd);
  const captures = {};
  let plugins = [];
  if (mode === 'inst') {
    plugins = await loadPlugin(opt('plugin'));
    const all = plugins;
    const sink = path.join(out, mode + '-captures.jsonl');
    plugins = plugins.map((p) => wrapTransform(p, captures, all, sink));
  }
  plugins.push(tsLowerPlugin());
  const rawDir = path.join(out, 'raw-' + mode);
  process.env.VTO_RAW_DIR = rawDir;
  process.env.VTO_CORPUS_OUT = path.join(out, mode);
  process.env.VTO_CORPUS_MODE = mode;
  if (opt('only')) process.env.VTO_CORPUS_ONLY = String(opt('only'));
  const { startVitest } = await import('vitest/node');
  const setupFiles = [];
  if (mode === 'inst' && opt('setup')) {
    // copied next to the harness so that its `import 'vitest'` resolves to the corpus' vitest
    const copy = path.join(HERE, 'harness', '.collector-setup' + path.extname(String(opt('setup'))));
    writeFileSync(copy, readFileSync(path.resolve(String(opt('setup')))));
    process.on('exit', () => rmSync(copy, { force: true }));
    setupFiles.push(copy);
  }
  let v;
  try {
    v = await startVitest(
      'test',
      [],
      { watch: false, run: true, config: false, root: cwd, reporters: ['dot'], passWithNoTests: true },
      {
        configFile: false,
        root: cwd,
        logLevel: 'error',
        plugins,
        test: {
          include: ['harness/corpus.test.tsx'],
          environment: 'jsdom',
          setupFiles,
          testTimeout: 20000,
          coverage: { enabled: false },
          includeTaskLocation: true,
          // Vitest 5 persists transformed modules across processes (fsModuleCache, default on) and the
          // cache key does not see plugin-internal changes: a cache hit would skip the instrumenter
          // (stale code, no transform call). Always transform fresh.
          fsModuleCache: false,
        },
      },
    );
  } finally {
    await v?.close();
  }
  process.exit(0);
}

// ------------------------------------------------------------------------------------------
// checks (parent)
// ------------------------------------------------------------------------------------------
let oxc;
async function parse(file, code) {
  oxc ??= await import('oxc-parser');
  const ext = path.extname(file).slice(1);
  const lang = ext === 'mts' ? 'ts' : ext;
  return oxc.parseSync(file, code, { lang, sourceType: 'module', astType: ext.startsWith('t') || ext === 'mts' ? 'ts' : 'js' });
}

function walk(node, fn, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, fn, parent);
    return;
  }
  if (typeof node.type === 'string') fn(node, parent);
  for (const k in node) {
    if (k === 'parent') continue;
    const v = node[k];
    if (v && typeof v === 'object') walk(v, fn, typeof node.type === 'string' ? node : parent);
  }
}

function directiveSignature(program) {
  // sequence of directive lists of every Program/function body, in source order
  const sig = [];
  walk(program, (n) => {
    const body = n.type === 'Program' ? n.body : null;
    if (/Function/.test(n.type) && n.body && n.body.type !== undefined && Array.isArray(n.body.body)) {
      const d = n.body.body.filter((s) => s.type === 'ExpressionStatement' && typeof s.directive === 'string').map((s) => s.directive);
      const lead = [];
      for (const s of n.body.body) {
        if (s.type === 'ExpressionStatement' && typeof s.directive === 'string') lead.push(s.directive);
        else break;
      }
      if (d.length) sig.push(lead.join('|') + (d.length !== lead.length ? '!!' : ''));
    }
    if (body) {
      const lead = [];
      for (const s of body) {
        if (s.type === 'ExpressionStatement' && typeof s.directive === 'string') lead.push(s.directive);
        else break;
      }
      if (lead.length) sig.push('P:' + lead.join('|'));
    }
  });
  return sig;
}

function opaqueSpans(program, comments) {
  // spans a block boundary must never fall strictly inside
  const spans = comments.map((c) => [c.start, c.end, 'comment']);
  walk(program, (n) => {
    if ((n.type === 'Literal' && (typeof n.value === 'string' || n.regex)) || n.type === 'StringLiteral') spans.push([n.start, n.end, 'string literal']);
    else if (n.type === 'TemplateElement') spans.push([n.start, n.end, 'template text']);
    else if (n.type === 'JSXText') spans.push([n.start, n.end, 'JSX text']);
    else if (n.type === 'Identifier' || n.type === 'JSXIdentifier' || n.type === 'PrivateIdentifier') spans.push([n.start, n.end, 'identifier']);
  });
  return spans;
}

const ID = /[\p{ID_Continue}$‌‍]/u;

function lineStarts(src) {
  const ls = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) ls.push(i + 1);
  return ls;
}

function checkBlocks(src, blocks, spans) {
  const errs = [];
  const ls = lineStarts(src);
  const lineLen = (l) => (l < ls.length ? ls[l] - 1 : src.length) - ls[l - 1];
  const offs = [];
  const toOff = (l, c, what, i) => {
    if (!Number.isInteger(l) || !Number.isInteger(c)) return errs.push(`block ${i}: ${what} not integers (${l},${c})`), null;
    if (l < 1 || l > ls.length) return errs.push(`block ${i}: ${what} line ${l} outside 1..${ls.length}`), null;
    const len = lineLen(l);
    if (c < 0 || c > len) return errs.push(`block ${i}: ${what} col ${c} outside 0..${len} of line ${l}`), null;
    return ls[l - 1] + c;
  };
  blocks.forEach((b, i) => {
    if (!Array.isArray(b) || b.length < 5) return errs.push(`block ${i}: malformed ${JSON.stringify(b)}`);
    const [sl, sc, el, ec, kind] = b;
    if (!['s', 'b', 'f'].includes(kind)) errs.push(`block ${i}: bad kind ${JSON.stringify(kind)}`);
    const s = toOff(sl, sc, 'start', i);
    const e = toOff(el, ec, 'end', i);
    if (s == null || e == null) return offs.push(null);
    if (s > e) errs.push(`block ${i}: start ${sl}:${sc} after end ${el}:${ec}`);
    for (const [o, what] of [[s, 'start'], [e, 'end']]) {
      const c = src.charCodeAt(o), p = src.charCodeAt(o - 1);
      if (c >= 0xdc00 && c <= 0xdfff && p >= 0xd800 && p <= 0xdbff) errs.push(`block ${i}: ${what} splits a surrogate pair (UTF-16 vs code point/byte offsets?)`);
      if (p === 13 && c === 10) errs.push(`block ${i}: ${what} between CR and LF`);
      if (o > 0 && o < src.length && ID.test(src[o - 1]) && ID.test(src[o])) errs.push(`block ${i}: ${what} ${what === 'start' ? sl + ':' + sc : el + ':' + ec} inside a word ${JSON.stringify(src.slice(Math.max(0, o - 8), o) + '|' + src.slice(o, o + 8))}`);
      for (const [a, z, k] of spans) {
        if (o > a && o < z) {
          errs.push(`block ${i}: ${what} ${what === 'start' ? sl + ':' + sc : el + ':' + ec} inside ${k} ${JSON.stringify(src.slice(a, Math.min(z, a + 30)))}`);
          break;
        }
      }
    }
    offs.push([s, e]);
  });
  return { errs, offs };
}

function markerIndices(program) {
  // AST based (string/comment look-alikes are ignored). A marker for block i is either
  //   __vto_<x>[i] = 1          (statement / comma-wrapped expression marker)
  //   __vto_<x>(i, ...)         (helper call, e.g. value-preserving logical-operand helpers)
  //   (__vto_<x> || __vto_<y>())[i] = 1   (hoisted-accessor marker, safe in import cycles)
  const idx = new Set();
  const isInt = (n) => n?.type === 'Literal' && Number.isInteger(n.value);
  const unparen = (n) => { while (n?.type === 'ParenthesizedExpression') n = n.expression; return n; };
  const isVto = (o) => { o = unparen(o); return (o?.type === 'Identifier' && /^__vto_/.test(o.name)) ||
    (o?.type === 'LogicalExpression' && o.operator === '||' && unparen(o.left)?.type === 'Identifier' && /^__vto_/.test(unparen(o.left).name)); };
  walk(program, (n) => {
    if (n.type === 'AssignmentExpression' && n.operator === '=') {
      const l = n.left;
      if (l?.type === 'MemberExpression' && l.computed && isVto(l.object) && isInt(l.property)) idx.add(l.property.value);
    } else if (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && /^__vto_/.test(n.callee.name) && isInt(n.arguments?.[0])) idx.add(n.arguments[0].value);
  });
  return idx;
}

function annotations(src) {
  const res = [];
  const re = /\/\*@(never|hit)\*\//g;
  let m;
  while ((m = re.exec(src))) {
    let p = m.index + m[0].length;
    while (/\s/.test(src[p] ?? '')) p++;
    res.push({ kind: m[1], at: p, ann: m.index });
  }
  return res;
}

function posOf(src, o) {
  const ls = lineStarts(src);
  let l = 0;
  while (l + 1 < ls.length && ls[l + 1] <= o) l++;
  return `${l + 1}:${o - ls[l]}`;
}

function stable(x) {
  return JSON.stringify(x);
}

function diffs(a, b, p = '$', out = []) {
  if (out.length >= 4 || stable(a) === stable(b)) return out;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${p}: ${trunc(stable(a))} !== ${trunc(stable(b))}`);
    return out;
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const missing = keys.filter((k) => !(k in a) || !(k in b));
  if (missing.length) { out.push(`${p}: keys differ (${missing.join(', ')})`); return out; }
  const n = out.length;
  for (const k of keys) diffs(a[k], b[k], `${p}.${k}`, out);
  if (out.length === n) out.push(`${p}: key order differs`);
  return out;
}
const trunc = (s, n = 160) => (s === undefined ? 'undefined' : s.length > n ? s.slice(0, n) + '…' : s);

function readRaw(dir) {
  const files = {};
  if (!existsSync(dir)) return files;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.t === 'file' && r.file) files[r.file.replace(/\\/g, '/')] = r.blocks;
      } catch {}
    }
  }
  return files;
}

// Runs a vitest child. A scenario that hangs (e.g. an instrumenter turned a loop infinite) blocks
// its worker forever, so each child gets a timeout; cases that started but produced no result are
// recorded as hung and the child is restarted for the remaining cases.
const CHILD_TIMEOUT = Number(opt('timeout', 90)) * 1000;
function runChild(mode, out, extra, names) {
  const hung = [];
  let log = '', status = 0;
  for (let round = 0; round < 20; round++) {
    const done = new Set(names.filter((n) => existsSync(path.join(out, mode, n + '.json'))));
    const skip = [...done, ...hung];
    if (round > 0 && skip.length >= names.length) break;
    const args = [fileURLToPath(import.meta.url), '--child', mode, '--out', out, ...extra];
    const r = spawnSync(process.execPath, args, {
      cwd: HERE, encoding: 'utf8', maxBuffer: 1 << 28, timeout: CHILD_TIMEOUT, killSignal: 'SIGKILL',
      env: { ...process.env, FORCE_COLOR: '0', VTO_CORPUS_SKIP: skip.join(',') },
    });
    log += `--- round ${round} status ${r.status} signal ${r.signal}\n` + (r.stdout ?? '') + '\n--- stderr ---\n' + (r.stderr ?? '');
    status = r.status ?? 1;
    if (!r.signal) break;
    const started = names.filter((n) => !skip.includes(n) && existsSync(path.join(out, mode, n + '.start')) && !existsSync(path.join(out, mode, n + '.json')));
    if (!started.length) break;
    hung.push(...started);
  }
  writeFileSync(path.join(out, mode + '-vitest.log'), log);
  return { status, hung, log };
}

async function main() {
  const pluginPath = path.resolve(String(opt('plugin', path.join(HERE, '..', 'plugin.mjs'))));
  const verbose = flag('verbose');
  const caseFiles = readdirSync(CASES).filter((f) => /\.(m?ts|tsx|jsx?)$/.test(f)).sort();
  const only = opt('only') ? String(opt('only')).split(',') : null;
  const selected = caseFiles.filter((f) => !only || only.some((o) => f.includes(o)));
  if (!existsSync(pluginPath)) {
    console.log(`SKIP: instrumenter plugin not found at ${pluginPath}`);
    console.log(`      (it has not been written yet?) Pass another one with --plugin <path>. ${selected.length} corpus cases available.`);
    process.exit(0);
  }
  try {
    await loadPlugin(pluginPath);
  } catch (e) {
    console.log(`FAIL: cannot load plugin ${pluginPath}: ${e?.stack ?? e}`);
    process.exit(2);
  }
  const out = mkdtempSync(path.join(tmpdir(), 'vto-corpus-'));
  const pass = [];
  if (only) pass.push('--only', only.join(','));
  console.log(`vto corpus: ${selected.length} cases, plugin ${path.relative(process.cwd(), pluginPath) || pluginPath}`);
  console.log(`work dir ${out}`);
  const rb = runChild('base', out, pass, selected);
  if (rb.status !== 0 && !rb.hung.length) {
    console.log('HARNESS ERROR: baseline vitest run failed:\n' + rb.log.slice(-6000));
    process.exit(2);
  }
  const setup = opt('setup');
  const ri = runChild('inst', out, [...pass, '--plugin', pluginPath, ...(setup ? ['--setup', String(setup)] : [])], selected);
  const instLog = ri.log;
  if (ri.status !== 0) console.log(`note: instrumented vitest child exited with ${ri.status} (see ${path.join(out, 'inst-vitest.log')})`);
  const tr = { captures: {}, blocksApi: {} };
  try {
    for (const line of readFileSync(path.join(out, 'inst-captures.jsonl'), 'utf8').split('\n')) {
      if (!line) continue;
      const x = JSON.parse(line);
      tr.captures[x.file] = x.cap;
      tr.blocksApi[x.file] = x.blocks;
    }
  } catch {
    console.log('note: no transform capture from instrumented child (plugin transform never called?)');
  }
  const raw = readRaw(path.join(out, 'raw-inst'));

  const results = [];
  const annStats = { never: 0, hit: 0 };
  let anyInstrumented = 0;
  const blockSources = {};
  const prelim = [];
  for (const f of selected) {
    const abs = path.join(CASES, f);
    const r = { case: f, fails: [], warns: [], info: {} };
    prelim.push(r);
    const read = (m) => {
      try {
        return JSON.parse(readFileSync(path.join(out, m, f + '.json'), 'utf8'));
      } catch {
        return null;
      }
    };
    const b = read('base');
    const i = read('inst');
    if (!b) r.fails.push('CORPUS: no baseline result');
    else if (b.error) r.fails.push('CORPUS: scenario throws on original source: ' + trunc(stable(b.error), 300));
    if (!b && rb.hung.includes(f)) r.fails.push('CORPUS: scenario hangs on original source');
    if (!i && ri.hung.includes(f)) r.fails.push(`instrumented scenario HUNG (no result within ${CHILD_TIMEOUT / 1000}s; infinite loop?)`);
    else if (!i) {
      const m = instLog.match(new RegExp(`${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*\\n([^\\n]*\\n){0,6}`));
      r.fails.push('instrumented run produced no result (crash / timeout / transform error)' + (m ? ': ' + trunc(m[0].replace(/\s+/g, ' '), 300) : ''));
    }
    if (b && i) {
      for (const k of ['exports', 'error', 'result', 'logs']) {
        for (const d of diffs(b[k], i[k], k)) r.fails.push(`DIFF ${d}`);
      }
      r.info.slowdown = b.ms > 0 ? i.ms / b.ms : null;
    }
    // ---- static checks on transform output
    const src = readFileSync(abs, 'utf8');
    const cap = tr.captures[abs];
    let output = cap?.output ?? null;
    const input = cap?.input ?? src;
    if (cap && cap.input !== src) r.warns.push(`transform input differs from file on disk (length ${cap.input.length} vs ${src.length}${src.charCodeAt(0) === 0xfeff ? ', BOM' : ''}); positions are checked against the transform input`);
    let marks = new Set();
    let outParsed = null;
    if (output && output !== input) {
      outParsed = await parse(abs, output);
      marks = markerIndices(outParsed.program);
      if (!marks.size && /__vto_\w*\s*\[\s*\d+\s*\]\s*=\s*1/.test(output.replace(/(['"`]).*?\1/g, ''))) marks = new Set([-1]); // unparsable but clearly instrumented
    }
    const instrumented = marks.size > 0;
    r.instrumented = instrumented;
    r.optOut = /\/\*\s*vto-ignore-file\s*\*\//.test(src);
    if (instrumented) anyInstrumented++;
    if (outParsed) {
      const p = outParsed;
      if (p.errors.length) r.fails.push('instrumented output does not parse: ' + trunc(p.errors.map((e) => e.message + (e.labels?.[0] ? ` @${posOf(output, e.labels[0].start)}` : '')).join('; '), 300));
      else {
        const po = await parse(abs, input);
        const s1 = directiveSignature(po.program), s2 = directiveSignature(p.program);
        if (stable(s1) !== stable(s2)) r.fails.push(`directive prologue changed: ${stable(s1)} -> ${stable(s2)}`);
      }
    }
    // ---- blocks
    let blocks = null, from = null;
    if (Array.isArray(tr.blocksApi[abs])) (blocks = tr.blocksApi[abs]), (from = 'plugin api/meta');
    else if (Array.isArray(i?.cov?.blocks)) (blocks = i.cov.blocks), (from = 'runtime global');
    else if (Array.isArray(raw[abs])) (blocks = raw[abs]), (from = 'VTO_RAW_DIR file record');
    else {
      const k = Object.keys(raw).find((x) => x.endsWith('/cases/' + f));
      if (k) (blocks = raw[k]), (from = 'VTO_RAW_DIR file record');
    }
    if (from) blockSources[from] = (blockSources[from] ?? 0) + 1;
    r.info.blocks = blocks?.length ?? null;
    const cov = i?.cov;
    const neverLoaded = !!i?.error && !cov?.found; // module crashed before registering: already reported as DIFF
    if ((instrumented || (blocks && blocks.length) || cov?.found) && !(neverLoaded && !blocks)) {
      if (!blocks) r.fails.push('instrumented, but block positions not obtainable (plugin api / transform meta / globalThis.__vto_blocks / $VTO_RAW_DIR file records; use --setup <collector setupFile>)');
      if (!cov?.found) r.fails.push(`instrumented, but no globalThis.__vto_reg entry for this file${cov ? ` (${cov.keys} keys registered)` : ''}`);
      if (blocks) {
        const pp = await parse(abs, input);
        const { errs, offs } = checkBlocks(input, blocks, opaqueSpans(pp.program, pp.comments));
        for (const e of errs.slice(0, 6)) r.fails.push('POS ' + e);
        if (errs.length > 6) r.fails.push(`POS … ${errs.length - 6} more position errors`);
        const n = blocks.length;
        const missing = [];
        for (let k = 0; k < n; k++) if (!marks.has(k)) missing.push(k);
        const extra = [...marks].filter((k) => k >= n);
        if (output && missing.length && !outParsed?.errors.length) r.fails.push(`${missing.length} block(s) have no marker in output (can never be hit): ${missing.slice(0, 10).join(',')}`);
        if (extra.length) r.fails.push(`markers reference non-existent blocks: ${extra.slice(0, 10).join(',')} (blocks=${n})`);
        if (cov?.found && cov.len !== n) r.fails.push(`registry array length ${cov.len} != block count ${n}`);
        // partial overlaps (blocks should nest or be disjoint)
        const ok = offs.map((o, k) => [o, k]).filter(([o]) => o);
        let overl = 0;
        for (let x = 0; x < ok.length && overl < 3; x++)
          for (let y = x + 1; y < ok.length; y++) {
            const [[a1, a2]] = ok[x], [[b1, b2]] = ok[y];
            if ((a1 < b1 && b1 < a2 && a2 < b2) || (b1 < a1 && a1 < b2 && b2 < a2)) {
              r.warns.push(`blocks ${ok[x][1]} and ${ok[y][1]} partially overlap`);
              if (++overl >= 3) break;
            }
          }
        // coverage sanity via /*@never*/ /*@hit*/ annotations
        if (cov?.found) {
          const hit = new Set(cov.hits);
          for (const a of annotations(input)) {
            let best = -1, bl = Infinity;
            offs.forEach((o, k) => {
              if (o && o[0] <= a.at && a.at < o[1] && o[1] - o[0] < bl) (best = k), (bl = o[1] - o[0]);
            });
            const where = posOf(input, a.at);
            annStats[a.kind]++;
            if (a.kind === 'never' && best >= 0 && hit.has(best)) r.fails.push(`COV never-executed code at ${where} reported hit (innermost block ${best} ${stable(blocks[best])})`);
            if (a.kind === 'hit' && best < 0) r.fails.push(`COV executed code at ${where} not covered by any block`);
            else if (a.kind === 'hit' && !hit.has(best)) r.fails.push(`COV executed code at ${where} not reported hit (innermost block ${best} ${stable(blocks[best])})`);
          }
          r.info.hits = cov.hits.length;
        }
      }
    }
  }
  for (const r of prelim) {
    if (r.optOut) { // `vto-ignore-file` pragma: registered (prelude) but no markers and an empty block table
      if (r.instrumented) r.fails.push('module carries the vto-ignore-file pragma but has hit markers');
      if (r.info.blocks) r.fails.push(`vto-ignore-file module has ${r.info.blocks} blocks`);
    } else if (anyInstrumented && !r.instrumented && !r.fails.length) r.fails.push('module was not instrumented (no __vto_ markers in transform output)');
    results.push(r);
  }

  // ---- report
  const failed = results.filter((r) => r.fails.length);
  for (const r of results) {
    const tag = r.fails.length ? 'FAIL' : 'pass';
    const inf = r.info.blocks != null ? ` [blocks ${r.info.blocks}${r.info.hits != null ? `, hit ${r.info.hits}` : ''}]` : '';
    if (r.fails.length || verbose) console.log(`${tag}  ${r.case}${inf}`);
    for (const m of r.fails) console.log(`        - ${m}`);
    if (verbose) for (const m of r.warns) console.log(`        ~ ${m}`);
  }
  const warnN = results.reduce((s, r) => s + r.warns.length, 0);
  console.log('');
  console.log(`instrumented modules: ${anyInstrumented}/${results.length}${anyInstrumented === 0 ? ' (plugin instrumented nothing: only differential checks apply)' : ''}`);
  if (Object.keys(blockSources).length) console.log(`block positions from: ${Object.entries(blockSources).map(([k, v]) => `${k} (${v})`).join(', ')}`);
  if (annStats.never + annStats.hit) console.log(`coverage annotations checked: ${annStats.never} never-executed, ${annStats.hit} executed`);
  if (warnN) console.log(`warnings: ${warnN} (use --verbose)`);
  console.log(`RESULT: ${results.length - failed.length}/${results.length} passed, ${failed.length} failed`);
  if (opt('json')) writeFileSync(String(opt('json')), JSON.stringify(results, null, 2));
  if (!flag('keep')) rmSync(out, { recursive: true, force: true });
  else console.log(`kept ${out}`);
  process.exit(failed.length ? 1 : 0);
}

if (opt('child')) child(String(opt('child'))).catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(3);
});
else main().catch((e) => {
  console.error('HARNESS ERROR', e?.stack ?? e);
  process.exit(2);
});
