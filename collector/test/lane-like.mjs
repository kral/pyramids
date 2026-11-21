// Test driver: starts Vitest the way an embedding tool (the daemon's lane) does – plugin + setup file added by
// hand, VTO_ROOT taken as given (NOT canonicalised), no run-raw.mjs. Used to prove that the worker side
// canonicalises the root itself.   node lane-like.mjs <root as given> <rawDir> [vitest args]
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const [root, rawDir, ...args] = process.argv.slice(2);
process.chdir(root);
process.env.VTO_ROOT = root;
process.env.VTO_RAW_DIR = rawDir;
fs.mkdirSync(rawDir, { recursive: true });
const req = createRequire(path.join(root, 'package.json'));
const { createVitest, parseCLI } = await import(pathToFileURL(req.resolve('vitest/node')).href);
const { default: vtoInstrument } = await import(pathToFileURL(path.join(here, '..', 'plugin.mjs')).href);
const setupDir = path.join(root, '.vto', 'setup'); // spelled through the given (possibly symlinked) root
fs.mkdirSync(setupDir, { recursive: true });
const setupFile = path.join(setupDir, 'setup-v2.mjs');
fs.copyFileSync(path.join(here, '..', 'setup-v2.mjs'), setupFile);
const { filter, options } = parseCLI(['vitest', 'run', ...args]);
const plugin = vtoInstrument();
const vitest = await createVitest('test', { ...options, watch: false, run: true }, { plugins: [plugin] }, { cliFilters: filter });
plugin.vto.setVitest(vitest);
for (const p of vitest.projects) { p.config.setupFiles.unshift(setupFile); p.config.maxConcurrency = 1; p.config.includeTaskLocation = true; }
try { await vitest.start(filter); } finally { await vitest.close(); }
process.exit(0);
