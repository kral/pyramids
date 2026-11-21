// The ONE content-hash definition of vto (contracts/DECISIONS.md, D1): lower-case hex SHA-256 of the
// file's BYTES after removing one leading UTF-8 BOM and replacing every CR LF by LF (a lone CR stays).
// Used for `file.sha256` in raw records. Never hash a decoded string – pass the Buffer read from disk.
import { createHash } from 'node:crypto';

/** @param {Uint8Array|string} buf file content (a string is encoded as UTF-8 first) */
export function contentHash(buf) {
  if (typeof buf === 'string') buf = Buffer.from(buf, 'utf8');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  let i = buf.indexOf(0x0d);
  if (i === -1) return createHash('sha256').update(buf).digest('hex'); // common case: no CR at all, no copy
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  if (i > 0) { buf.copy(out, 0, 0, i); n = i; }
  for (; i < buf.length; i++) { if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue; out[n++] = buf[i]; }
  return createHash('sha256').update(out.subarray(0, n)).digest('hex');
}
