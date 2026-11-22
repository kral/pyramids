// Architecture review 3 S4: the signature goes into the committed incompatible.json / conflicts.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signature } from '../src/runner.mjs';


test('S4: signatures carry no machine paths or user names (Windows, UNC, file URLs, home directories)', () => {
  const W = { root: 'C:\\Users\\jiri\\proj', home: 'C:\\Users\\jiri' };
  assert.equal(signature('Error: Cannot find module C:\\Users\\jiri\\proj\\src\\a.ts imported from file:///C:/Users/jiri/proj/src/b.ts', W), 'Error: Cannot find module src/a.ts imported from src/b.ts');
  assert.equal(signature('Error: Cannot find module c:\\users\\JIRI\\proj\\src\\a.ts', W), 'Error: Cannot find module src/a.ts');
  assert.equal(signature('Error: ENOENT C:\\Users\\jiri\\other\\x.json', W), 'Error: ENOENT <path>');
  assert.equal(signature("Error: ENOENT 'C:\\Users\\Jiri Kral\\proj\\x.json'", W), "Error: ENOENT '<path>'");
  assert.equal(signature('Error: ENOENT D:/work/x.json and \\\\server\\share\\dir\\f.ts', W), 'Error: ENOENT <path> and <path>');
  const P = { root: '/home/jiri/proj', home: '/home/jiri' };
  assert.equal(signature('Error: at /home/jiri/proj/src/a.ts:3:4', P), 'Error: at src/a.ts:N:N');
  assert.equal(signature('Error: at /home/jiri/projX/a.ts and /opt/ci/b.ts and src/c.ts 1/2', P), 'Error: at <path> and <path> and src/c.ts N/N');
  assert.equal(signature('Error: file:///home/jiri/proj/a.ts:1', P), 'Error: a.ts:N');
  assert.equal(signature('Error: /var/lib/ci/x.ts', { root: '/w', home: '/var/lib/ci' }), 'Error: <path>');
  // the same failure on two machines has the same signature
  assert.equal(signature('TypeError: x is not a function at C:\\Users\\a\\p\\src\\m.ts:1:2', { root: 'C:\\Users\\a\\p', home: 'C:\\Users\\a' }),
    signature('TypeError: x is not a function at /home/b/p/src/m.ts:1:2', { root: '/home/b/p', home: '/home/b' }));
});
