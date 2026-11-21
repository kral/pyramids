#!/usr/bin/env node
// vto MCP server (stdio).  vto-mcp [--root DIR] [--no-daemon]
// Root: --root, else VTO_ROOT, else the nearest vitest/vite config or package.json above the cwd.
import path from 'node:path';
import { startMcp } from '../src/mcp-server.mjs';
import { findRoot } from '../src/client.mjs';

const a = process.argv.slice(2);
const i = a.indexOf('--root');
const root = path.resolve(i >= 0 ? a[i + 1] : process.env.VTO_ROOT || findRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd()));
await startMcp({ root, daemon: !a.includes('--no-daemon') && process.env.VTO_NO_DAEMON !== '1' });
