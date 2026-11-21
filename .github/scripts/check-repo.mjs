#!/usr/bin/env node
// Repository hygiene checks that need no dependency and no build (CI step `lint`).
//   1. samples/ hold no source code and no absolute paths (SECURITY F11)
//   2. workflows: actions pinned by commit SHA, least-privilege permissions, no pull_request_target,
//      checkout without persisted credentials, no retired runner images
//   3. docs: no `npx <unscoped name>` that npm could resolve to a foreign package; relative links resolve
//   4. manifests: licence and Node range declared consistently
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.VTO_CI_REPO ? path.resolve(process.env.VTO_CI_REPO) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const problems = [];
const bad = (file, msg) => problems.push(`${path.relative(REPO, file)}: ${msg}`);
const read = (f) => fs.readFileSync(f, 'utf8');
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'target', '.git', 'dist'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.isFile()) out.push(p);
  }
  return out;
}

// ---- 1. samples
const ABS = /(?:^|["'\s(=:])(?:\/(?:home|Users|root|tmp|var|private|mnt|opt)\/|[A-Za-z]:[\\/]{1,2}(?:Users|src|tools|a|proj)\b|file:\/\/)/;
for (const f of walk(path.join(REPO, 'samples'))) {
  const text = read(f);
  if (ABS.test(text)) bad(f, 'contains an absolute path');
  if (!f.endsWith('.jsonl')) continue;
  for (const [i, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { bad(f, `line ${i + 1} is not JSON`); continue; }
    if (r.t === 'script' || 'source' in r || 'code' in r) bad(f, `line ${i + 1}: record carries source code (t=${r.t})`);
    if (r.t === 'meta' && typeof r.root === 'string') bad(f, `line ${i + 1}: meta.root records a machine path`);
  }
}

// ---- 2. workflows
const RETIRED = /\b(macos-1[0-3]|ubuntu-(18|20)\.04|windows-2019)\b/;
for (const f of walk(path.join(REPO, '.github', 'workflows')).filter((p) => /\.ya?ml$/.test(p))) {
  const text = read(f);
  const lines = text.split('\n');
  if (!/^permissions:/m.test(text)) bad(f, 'no top-level `permissions:` (least privilege)');
  if (/^permissions:\s*write-all/m.test(text)) bad(f, '`permissions: write-all`');
  if (/pull_request_target/.test(text.replace(/#.*$/gm, ''))) bad(f, 'uses pull_request_target');
  for (const [i, l] of lines.entries()) {
    const code = l.replace(/\s+#.*$/, '');
    const m = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(code);
    if (m && !m[1].startsWith('./')) {
      if (!/@[0-9a-f]{40}$/.test(m[1])) bad(f, `line ${i + 1}: action not pinned by commit SHA: ${m[1]}`);
      else if (!/#\s*v?\d/.test(l)) bad(f, `line ${i + 1}: pinned action without a version comment`);
      if (/actions\/checkout@/.test(m[1])) {
        const block = lines.slice(i, i + 8).join('\n');
        if (!/persist-credentials:\s*false/.test(block)) bad(f, `line ${i + 1}: checkout without persist-credentials: false`);
      }
    }
    if (RETIRED.test(code)) bad(f, `line ${i + 1}: retired runner image (${RETIRED.exec(code)[0]})`);
    if (/\$\{\{\s*github\.event\.(pull_request\.(title|body|head\.ref)|issue|comment|head_commit\.message)/.test(code) && /^\s*(run:|-\s|\S)/.test(code) && !/^\s*[A-Z_]+:\s/.test(code)) {
      bad(f, `line ${i + 1}: untrusted event text interpolated into a step (pass it through env:)`);
    }
  }
}

// ---- 3. docs (the ones this check owns; package READMEs of other components are linted for npx only)
const BIN_NAMES = 'vm-guard|vto|vto-daemon|vto-mcp|vto-ui|vitest-overlap';
const NPX = new RegExp(`\\bnpx\\s+(?!--no-install\\b)(?:-y\\s+|--yes\\s+)?(?:${BIN_NAMES})\\b`);
const docs = [
  ...fs.readdirSync(REPO).filter((f) => /^(README.*|SECURITY|CONTRIBUTING)\.md$|^README/.test(f)).map((f) => path.join(REPO, f)),
  ...walk(path.join(REPO, 'docs')).filter((f) => /\.(md|ya?ml)$/.test(f)),
  ...['tui', 'mcp', 'vm-guard', 'samples'].flatMap((d) => (fs.existsSync(path.join(REPO, d)) ? fs.readdirSync(path.join(REPO, d)).filter((f) => /^README.*\.md$/.test(f)).map((f) => path.join(REPO, d, f)) : [])),
];
for (const f of docs) {
  const text = read(f);
  for (const [i, l] of text.split('\n').entries()) {
    // a line that warns about the pattern may quote it
    if (NPX.test(l) && !/do not|don't|never|nespouštějte|unrelated|foreign|cizí/i.test(l)) bad(f, `line ${i + 1}: \`npx <unscoped name>\` can download a foreign npm package – use \`npx --no-install\` or \`node <vto>/bin/vto.mjs\``);
  }
  if (!f.endsWith('.md')) continue;
  const stripped = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const m of stripped.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const p = path.resolve(path.dirname(f), decodeURIComponent(target.split('#')[0]));
    if (!fs.existsSync(p)) bad(f, `dead relative link: ${target}`);
  }
}

// ---- 4. manifests
const LICENSE = 'MIT OR Apache-2.0';
for (const rel of ['package.json', 'tui/package.json', 'mcp/package.json', 'vm-guard/package.json']) {
  const f = path.join(REPO, rel);
  if (!fs.existsSync(f)) continue;
  const p = JSON.parse(read(f));
  if (p.license !== LICENSE) bad(f, `"license" is ${JSON.stringify(p.license)}, expected "${LICENSE}"`);
  if (!p.engines?.node) bad(f, 'no engines.node');
  if (/^(vm-guard|vto)$/.test(p.name ?? '')) bad(f, `package name "${p.name}" belongs to somebody else on npm – use a scope`);
}
for (const f of ['LICENSE-MIT', 'LICENSE-APACHE', 'SECURITY.md', 'README.md']) if (!fs.existsSync(path.join(REPO, f))) bad(path.join(REPO, f), 'missing');

if (problems.length) {
  process.stderr.write(`check-repo: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`  check-repo: samples, workflows, ${docs.length} docs, manifests – ok\n`);
