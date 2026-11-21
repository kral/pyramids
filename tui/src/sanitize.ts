// One sanitiser for every string that does not come from vto itself: daemon events, run logs
// (`--file`, `--latest`, `--stdin`), source lines read for code frames, clipboard payloads.
// Applied where the data enters (events.ts, codeframe.ts) and again where it leaves
// (prompt.ts, clipboard.ts, ci.ts), so no path depends on the other one.
//
// Removed: complete ANSI sequences (CSI, OSC incl. OSC 8 hyperlinks and OSC 52, DCS/SOS/PM/APC
// strings), every remaining C0 control except \n and \t, DEL, C1, bidi controls, zero-width and
// invisible format characters, Unicode tag characters (U+E0000–E007F), interlinear annotation
// and object-replacement characters. U+2028/U+2029/NEL/VT/FF become "\n" (they are line breaks
// for Markdown renderers and many terminals).

// ESC [ … final | ESC ] … (BEL | ST) | ESC P/X/^/_ … ST | other two-byte ESC sequences | lone ESC
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)|\x1b[PX^_][^\x1b\x9c]*(?:\x1b\\|\x9c|$)|\x1b[ -/]*[0-~]?|\x9b[0-?]*[ -/]*[@-~]|\x9d[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)/g;
const LINE_BREAKS = /\r\n?|[\x0b\x0c\x85\u2028\u2029]/g;
// C0 without \t \n, DEL, C1, soft hyphen, Arabic letter mark, zero-width + bidi marks/embeddings/
// isolates, word joiner + invisible operators, deprecated format chars, BOM, interlinear
// annotations, object replacement, Mongolian vowel separator, Hangul fillers, tag characters.
const INVISIBLE = /[\x00-\x08\x0e-\x1f\x7f-\x9f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\ufff9-\ufffc\uffa0]|\udb40[\udc00-\udc7f]/g;
// unpaired surrogates would make JSON / UTF-16LE clipboard payloads ill-formed
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Multi-line text (messages, diffs, clipboard): keeps "\n" and "\t", removes everything listed above. */
export function cleanText(s: string, maxLen = 64_000): string {
  if (typeof s !== 'string') return '';
  let out = s.length > maxLen * 2 ? s.slice(0, maxLen * 2) : s;
  // the fast path matters: 10k events × several fields per run
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ud800-\udfff\ufeff\ufff9-\ufffc\uffa0]/.test(out)) {
    out = out.replace(ANSI, '').replace(LINE_BREAKS, '\n').replace(INVISIBLE, '').replace(LONE_SURROGATE, '�');
  }
  return out.length > maxLen ? out.slice(0, maxLen) + '…' : out;
}

/** Single-line value (test ids, paths, run ids, pool/project names, one source line). */
export function cleanLine(s: string, maxLen = 2000): string {
  if (typeof s !== 'string') return '';
  const out = cleanText(s, maxLen);
  return /[\n\t]/.test(out) ? out.replace(/\s*\n\s*/g, ' ').replace(/\t/g, ' ') : out;
}

/**
 * A line that is safe to print in a CI log: GitHub Actions parses `::command::` after trimming
 * leading whitespace, Azure Pipelines parses `##vso[…]` / `##[…]`. Untrusted text never keeps them.
 */
export function ciSafe(line: string): string {
  let out = line;
  // leading whitespace and our own SGR colour codes do not hide a command from the runner
  out = out.replace(/^((?:\s|\x1b\[[0-9;]*m)*)::/, '$1:\u2236'); // "::" → ":∶" (ratio sign)
  if (out.includes('##')) out = out.replace(/##(vso)?\[/gi, '#\u2236#$1[');
  return out;
}

/** Longest run of `ch` in `s` (used to build a fence that the body cannot close). */
export function longestRun(s: string, ch: string): number {
  let best = 0, cur = 0;
  for (let i = 0; i < s.length; i++) { if (s[i] === ch) { cur++; if (cur > best) best = cur; } else cur = 0; }
  return best;
}
