#!/usr/bin/env node
import { main } from '../src/cli.mjs';
// a linked state directory (statefs.mjs) or a newer state format (stateformat.mjs) found mid-command is a usage error (exit 2)
const STATE_ERRORS = new Set(['E_UNSAFE_STATE', 'E_STATE_VERSION']);
main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { if (STATE_ERRORS.has(e?.code)) { console.error(e.message); process.exit(2); } console.error(e?.stack || e); process.exit(1); });
