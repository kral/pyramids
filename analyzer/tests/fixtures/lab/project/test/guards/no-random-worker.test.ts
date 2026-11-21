import { it, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
it('src/price.ts never uses Math.random (read in a worker thread)', async () => {
  const src: string = await new Promise((res, rej) => {
    const w = new Worker(`require('worker_threads').parentPort.postMessage(require('fs').readFileSync('src/price.ts','utf8'))`, { eval: true });
    w.on('message', res); w.on('error', rej);
  });
  expect(src).not.toContain('Math.random');
});
