// Classify Vitest/Jest-style diff lines for colouring (expected = green "-", received = red "+").
export type DiffKind = 'expected' | 'received' | 'header' | 'context';
export interface DiffLine { kind: DiffKind; text: string }

export function classifyDiff(diff: string, maxLines = 40): { lines: DiffLine[]; truncated: number } {
  const raw = diff.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  const lines: DiffLine[] = [];
  for (let i = 0; i < raw.length && lines.length < maxLines; i++) {
    const l = raw[i];
    if (/^- Expected\b/.test(l) || /^\+ Received\b/.test(l)) lines.push({ kind: 'header', text: l });
    else if (/^Expected:?\s/.test(l)) lines.push({ kind: 'expected', text: l });
    else if (/^Received:?\s/.test(l)) lines.push({ kind: 'received', text: l });
    else if (l.startsWith('-')) lines.push({ kind: 'expected', text: l });
    else if (l.startsWith('+')) lines.push({ kind: 'received', text: l });
    else lines.push({ kind: 'context', text: l });
  }
  return { lines, truncated: Math.max(0, raw.length - lines.length) };
}
