#!/usr/bin/env node
// Dev helper: call vto MCP tools over stdio like a client would and print size/token stats.
//   node dev/mcp-call.mjs --root DIR [--no-daemon] tool '{"json":"args"}' [tool args]...
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const a = process.argv.slice(2);
const ri = a.indexOf('--root');
const root = ri >= 0 ? a.splice(ri, 2)[1] : process.cwd();
const nd = a.indexOf('--no-daemon');
const noDaemon = nd >= 0 ? (a.splice(nd, 1), true) : false;
const quiet = a.includes('--quiet') ? (a.splice(a.indexOf('--quiet'), 1), true) : false;
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(here, '../bin/vto-mcp.mjs'), '--root', root, ...(noDaemon ? ['--no-daemon'] : [])], stderr: 'inherit' });
const client = new Client({ name: 'vto-dev', version: '0' });
await client.connect(transport);
if (!a.length) { const t = await client.listTools(); console.log(t.tools.map((x) => x.name).join('\n')); }
for (let i = 0; i < a.length; i += 2) {
  const name = a[i], args = a[i + 1] ? JSON.parse(a[i + 1]) : {};
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 3600e3, onprogress: (p) => !quiet && console.error(`  progress ${p.progress}/${p.total ?? '?'} ${p.message ?? ''}`) });
  const text = r.content.map((c) => c.text).join('');
  console.log(JSON.stringify({ tool: name, ms: Date.now() - t0, chars: text.length, tokens: Math.ceil(text.length / 4), isError: !!r.isError }));
  if (!quiet) console.log(text);
}
await client.close();
