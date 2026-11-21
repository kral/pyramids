// Escaping for verify.md / log lines. Same rules as the analyzer (analyzer/src/sanitize.rs):
// everything that comes from the project under test – test names, file paths, source snippets in
// mutant descriptions, literal values in reasons – is untrusted. A report is read in terminals,
// rendered by GitHub / Azure DevOps / VS Code and fed to AI agents.

// C0, DEL, C1, bidi, zero-width / invisible format characters, line separators, BOM, tag characters
const DANGEROUS = /[\x00-\x1f\x7f-\x9f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufeff\ufff9-\ufffc\uffa0]|[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g;
const isTag = (cp) => cp >= 0xe0000 && cp <= 0xe007f;

/** Terminal-safe single line: every dangerous code point becomes a visible `\u{…}` escape. */
export function term(s) {
  return String(s).replace(DANGEROUS, (m) => {
    const cp = m.codePointAt(0);
    if (m.length === 2 && !isTag(cp)) return m; // ordinary astral character (emoji, CJK ext.)
    return `\\u{${cp.toString(16)}}`;
  });
}

const HTML = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
/**
 * Markdown/HTML-safe inline text: term() + HTML-escaping of & < > + backslash-escaping of every
 * Markdown special, so the input can open no tag, link, image, code span, heading, emphasis,
 * table cell or autolink. Renders as the literal input text.
 */
export function md(s) {
  return term(s)
    .replace(/[&<>]/g, (c) => HTML[c])
    .replace(/[\\`*_[\](){}|#!~$]|^(\s*\d+)\./g, (c, n) => (n !== undefined ? `${n}\\.` : `\\${c}`))
    .replace(/:\/\//g, ':\\//')   // bare URL autolinks (GFM)
    .replace(/@/g, '&#64;');       // @mentions notify people on GitHub / Azure DevOps
}

/** Cap + md(): one table cell. */
export function cell(s, max = 300) {
  const str = String(s);
  return md(str.length > max ? str.slice(0, max) + '…' : str);
}
