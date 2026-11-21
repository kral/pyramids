#!/usr/bin/env node
// Builds the npm package directory for one prebuilt analyzer binary: @jirikral/vto-analyzer-<platform>-<arch>.
// The JS packages list all of them as optionalDependencies; npm installs only the one whose
// os/cpu match (same scheme as esbuild / oxc / swc). The resolver (src/analyzer.mjs) never uses PATH.
//   node scripts/pack-analyzer.mjs --target x86_64-pc-windows-msvc --npm win32-x64 --bin <path> --out dist
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const a = process.argv.slice(2);
const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
const npm = opt('--npm'), bin = opt('--bin'), out = opt('--out') || 'dist', target = opt('--target');
const [platform, arch] = npm.split('-');
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version;
const dir = path.join(out, `analyzer-${npm}`);
fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
const exe = platform === 'win32' ? 'vto.exe' : 'vto';
fs.copyFileSync(bin, path.join(dir, 'bin', exe));
if (platform !== 'win32') fs.chmodSync(path.join(dir, 'bin', exe), 0o755);
const sha256 = createHash('sha256').update(fs.readFileSync(bin)).digest('hex');
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
  name: `@jirikral/vto-analyzer-${npm}`, version, description: `vto analyzer binary for ${target}`,
  os: [platform], cpu: [arch], files: ['bin/'], license: 'MIT OR Apache-2.0', preferUnplugged: true,
  vto: { target, sha256 },
}, null, 2) + '\n');
// pin the hash in the daemon package itself: the resolver trusts only this manifest (SECURITY N1a)
const manifestFile = opt('--manifest') || new URL('../analyzer-manifest.json', import.meta.url);
let manifest = { version: 1, binaries: {} };
try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch {}
((manifest.binaries ||= {})[`@jirikral/vto-analyzer-${npm}`] ||= {})[version] = { sha256, target };
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
console.log(`${dir} (${target}, sha256 ${sha256.slice(0, 16)}…)`);
