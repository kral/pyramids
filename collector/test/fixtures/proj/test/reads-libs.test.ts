import { expect, it } from 'vitest';
import gfs from 'graceful-fs';
import fse from 'fs-extra';
import fg from 'fast-glob';
it('graceful-fs', () => { expect(gfs.readFileSync('docs/gfs.txt', 'utf8').trim()).toBe('gfs'); });
it('fs-extra', async () => { expect((await fse.readJson('docs/fse.json')).ok).toBe(true); });
it('fast-glob', async () => { expect(await fg('docs/fg/*.txt')).toEqual(['docs/fg/one.txt']); });
