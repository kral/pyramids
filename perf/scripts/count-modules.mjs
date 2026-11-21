// --import preload for Vitest workers: counts module files loaded per package (ESM+CJS) via module.registerHooks.
import { registerHooks } from 'node:module'; import fs from 'node:fs';
const counts = new Map();
registerHooks({ load(url, ctx, next) {
  const r = next(url, ctx);
  const pkg = url.match(/node_modules\/((@[^/]+\/)?[^/]+)/)?.[1] ?? (url.startsWith('node:') ? 'node:builtin' : 'other');
  const c = counts.get(pkg) ?? { files: 0, bytes: 0 }; c.files++; c.bytes += r.source ? (r.source.length ?? r.source.byteLength ?? 0) : 0; counts.set(pkg, c);
  return r;
}});
const out = (process.env.MODCOUNT_OUT || '/tmp/modcount') + '.' + process.pid + '.json';
const dump = () => fs.writeFileSync(out, JSON.stringify(Object.fromEntries(counts)));
setInterval(dump, 100).unref(); process.on('exit', dump);
