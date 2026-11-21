import { expect, it } from 'vitest';
import fs, { openSync, readSync, closeSync, createReadStream, copyFileSync, cpSync, globSync, readFileSync } from 'node:fs';
import { open, copyFile, glob } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vto-fx-'));
it('openSync + readSync', () => {
  const fd = openSync('src/b.txt', 'r'); const buf = Buffer.alloc(3); readSync(fd, buf); closeSync(fd);
  expect(buf.toString()).toBe('bbb');
});
it('FileHandle', async () => { const fh = await open('src/c.txt'); expect((await fh.readFile('utf8')).trim()).toBe('ccc'); await fh.close(); });
it('copyFile / cp', async () => {
  copyFileSync('src/d.txt', path.join(tmp, 'd')); await copyFile('src/e.txt', path.join(tmp, 'e')); cpSync('src/f.txt', path.join(tmp, 'f'));
  expect(readFileSync(path.join(tmp, 'd'), 'utf8').trim()).toBe('ddd');
});
it('glob', async () => {
  expect(globSync('src/tree/**/*.txt').length).toBe(2);
  const out = []; for await (const f of glob('*.md', { cwd: 'docs' })) out.push(f);
  expect(out).toEqual(['api.md']);
});
it('createReadStream', async () => {
  let s = ''; for await (const c of createReadStream('src/g.txt', 'utf8')) s += c;
  expect(s.trim()).toBe('ggg');
});
it('dot-dot and URL', () => {
  expect(readFileSync('test/../src/h.txt', 'utf8').trim()).toBe('hhh');
  expect(readFileSync(new URL('../docs/url.txt', import.meta.url), 'utf8').trim()).toBe('url');
});
