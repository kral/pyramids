// Security review 3 S3 / H1: names from the project or from committed state must not drive the terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readQuarantine } from '../src/index.mjs';
import { sanitize, sanitizeText, validateTestPaths } from '../src/safety.mjs';

const mk = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vmg-san-')));
const w = (root, f, txt) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), txt); };
const quiet = (fn) => { const l = console.log, wn = console.warn; let out = ''; console.log = console.warn = (...a) => { out += a.join(' ') + '\n'; }; try { fn(); } finally { console.log = l; console.warn = wn; } return out; };


test('H1: sanitize / sanitizeText make C0, ESC, C1, DEL, bidi and invisible characters visible', () => {
  assert.equal(sanitize('a\x1b[2Jb'), 'a\\u001b[2Jb');
  assert.equal(sanitize('x\u009b31m\u009d0;t\x07'), 'x\\u009b31m\\u009d0;t\\u0007');
  assert.equal(sanitize('src/\u202egnp.test.ts\u2066\u200b\ufeff'), 'src/\\u202egnp.test.ts\\u2066\\u200b\\ufeff');
  assert.equal(sanitize('one\ntwo\r'), 'one\\u000atwo\\u000d');
  assert.equal(sanitize('ok/čeština 😀.test.ts'), 'ok/čeština 😀.test.ts');
  assert.equal(sanitize('x'.repeat(500), 10), 'xxxxxxxxxx…');
  assert.equal(sanitizeText('line 1\r\n\x1b[31mred\x1b[0m\t\x1b]8;;https://e.example\x07link'), 'line 1\n\x1b[31mred\x1b[0m\t\\u001b]8;;https://e.example\\u0007link');
});

test('H1: warnings about committed incompatible.json entries print no raw C1 / bidi / ESC', () => {
  const root = mk();
  w(root, '.vitest-guard/incompatible.json', JSON.stringify({ vm: { 'x\u009b2J\u009b31mINJECTED\u009b0m.test.ts': {}, 'src/\u202egnp.test.ts': {}, '\x1b]8;;https://evil.example\x07click\x1b]8;;\x07': {} } }));
  const out = quiet(() => readQuarantine(root, 'vm'));
  assert.match(out, /ignoring/);
  assert.doesNotMatch(out, /[\x1b\u009b\u202e\x07]/);
  const out2 = quiet(() => validateTestPaths(root, ['a'], { label: 'lab\u009bel' }));
  assert.doesNotMatch(out2, /\u009b/);
});
