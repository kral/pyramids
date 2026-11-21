import { expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
it('worker reads a file', async () => {
  const src: string = await new Promise((res, rej) => {
    const w = new Worker(`require('worker_threads').parentPort.postMessage(require('fs').readFileSync('src/b.txt','utf8'))`, { eval: true });
    w.on('message', res); w.on('error', rej);
  });
  expect(src.trim()).toBe('bbb');
});
