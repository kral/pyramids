#!/usr/bin/env node
// vto ui launcher. React must load its production build (the development build is ~3× slower
// per frame), so NODE_ENV is set before anything imports React. Built output: ../dist (npm run build).
process.env.NODE_ENV ??= 'production';
const { main } = await import('../dist/cli.js');
main().then((code) => process.exit(code), (e) => { process.stderr.write(`vto ui: ${e?.stack ?? e}\n`); process.exit(2); });
