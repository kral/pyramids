// Unit tests of the collector's path rules (setup-v2.mjs makePaths; contracts/DECISIONS.md D2) with
// Windows / case-insensitive / NFD inputs, runnable on any OS. The factory is reached through the
// collector's per-worker state.
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const state = (vm.runInThisContext('globalThis') as any).__vto_state;
const make = (o: any) => state.makePaths({ path, fileURLToPath, ...o });

describe('windows', () => {
  const p = make({ root: 'C:\\Proj', alts: ['P:\\'], win: true, ci: true, cwd: () => 'C:\\Proj' });
  it('file URL reads become drive paths, not /C:/…', () => {
    expect(p.read(new URL('file:///C:/Proj/src/x.css'))).toBe('src/x.css');
    expect(p.read({ href: 'file:///c:/proj/src/My%20File.css', protocol: 'file:' })).toBe('src/My File.css');
    expect(p.read('file:///C:/Proj/src/x.css')).toBe('src/x.css');
  });
  it('module filter folds drive-letter and directory case', () => {
    expect(p.relIn('c:/Proj/src/a.ts')).toBe('src/a.ts');
    expect(p.relIn('C:/proj/src/a.ts')).toBe('src/a.ts');
    expect(p.relIn('C:\\Proj\\src\\a.ts')).toBe('src/a.ts');
    expect(p.relIn('C:/Project2/src/a.ts')).toBe(null);
    expect(p.relIn('D:/Proj/src/a.ts')).toBe(null);
  });
  it('backslashes, relative paths, `..`, trailing separators', () => {
    expect(p.read('src\\sub\\..\\x.css')).toBe('src/x.css');
    expect(p.read('C:\\Proj\\tests\\..\\src\\x.css')).toBe('src/x.css');
    expect(p.read('C:\\Proj\\src\\')).toBe('src');
    expect(p.read('C:\\Other\\x.css')).toBe(null);
    expect(p.read('C:\\Proj\\node_modules\\x\\index.js')).toBe(null);
  });
  it('other spellings of the root (subst drive, \\\\?\\ prefix) are the same project', () => {
    expect(p.read('P:\\src\\x.css')).toBe('src/x.css');
    expect(p.rel('\\\\?\\C:\\Proj\\src\\a.ts')).toBe('src/a.ts');
  });
  it('files outside the root keep an absolute path with / and an upper-case drive letter', () => {
    expect(p.rel('d:\\lib\\a.ts')).toBe('D:/lib/a.ts');
  });
  it('glob base', () => {
    expect(p.read(p.globBase('src\\**\\*.ts', undefined))).toBe('src');
    expect(p.read(p.globBase('**/*.ts', 'C:\\Proj\\docs'))).toBe('docs');
  });
});

describe('posix', () => {
  const p = make({ root: '/work/proj', alts: ['/links/proj'], win: false, ci: false, cwd: () => '/work/proj/packages/a' });
  it('case-sensitive by default', () => {
    expect(p.relIn('/work/proj/src/a.ts')).toBe('src/a.ts');
    expect(p.relIn('/work/Proj/src/a.ts')).toBe(null);
    expect(p.relIn('/work/project/src/a.ts')).toBe(null);
  });
  it('relative reads resolve against the cwd; `..` and `.` are resolved', () => {
    expect(p.read('src/x.css')).toBe('packages/a/src/x.css');
    expect(p.read('../../tests/../src/./x.css')).toBe('src/x.css');
    expect(p.read('../../..')).toBe(null);
    expect(p.read('/work/proj')).toBe('.');
    expect(p.read('/work/proj/')).toBe('.');
    expect(p.read('/etc/passwd')).toBe(null);
  });
  it('a symlinked spelling of the root is accepted', () => {
    expect(p.read('/links/proj/src/x.css')).toBe('src/x.css');
    expect(p.rel('/links/proj/src/a.ts')).toBe('src/a.ts');
  });
  it('URL and Buffer paths', () => {
    expect(p.read(new URL('file:///work/proj/src/a%20b.txt'))).toBe('src/a b.txt');
    expect(p.read(Buffer.from('/work/proj/src/b.txt'))).toBe('src/b.txt');
    expect(p.read(42 as any)).toBe(null);
  });
  it('NFD spellings are written as NFC', () => {
    expect(p.rel('/work/proj/src/c\u030cen\u00edk.ts')).toBe('src/\u010den\u00edk.ts');
    expect(p.read('/work/proj/src/c\u030cen\u00edk.ts')).toBe('src/\u010den\u00edk.ts');
  });
  it('glob base is the static prefix of the pattern', () => {
    expect(p.read(p.globBase('/work/proj/src/**/*.ts', undefined))).toBe('src');
    expect(p.read(p.globBase('*.md', '/work/proj/docs'))).toBe('docs');
    expect(p.read(p.globBase('/work/proj/src/a.ts', undefined))).toBe('src/a.ts');
    expect(p.read(p.globBase('{a,b}/*.ts', new URL('file:///work/proj/')))).toBe('.');
  });
});

describe('case-insensitive posix (macOS) with a non-ASCII root', () => {
  const p = make({ root: '/Users/Jir\u030ci\u0301/M\u016fj projekt', win: false, ci: true, cwd: () => '/' });
  it('folds case and normalises the root itself', () => {
    expect(p.root).toBe('/Users/Ji\u0159\u00ed/M\u016fj projekt/');
    expect(p.relIn('/users/ji\u0159\u00ed/m\u016fj projekt/src/A.ts')).toBe('src/A.ts');
    expect(p.read('/Users/Jir\u030ci\u0301/M\u016fj projekt/src/x.css')).toBe('src/x.css');
  });
});
