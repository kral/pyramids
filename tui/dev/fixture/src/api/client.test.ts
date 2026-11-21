import { describe, it, expect, vi } from 'vitest';
import { retry } from './client';

describe('retry', () => {
  it('gives up after 3 attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('down'));
    await expect(retry(fn)).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
