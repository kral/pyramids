// Secret redaction for everything that leaves the engine (MCP responses, IPC events, CLI JSON).
// Agent transcripts may be logged by third parties: console output and error messages of tests
// often contain tokens, connection strings or env values.
const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED:jwt]'],
  // AWS secret access key: by name, and any 40-char base64 token in a text that also holds a key id
  [/\b((?:aws_?)?secret_?access_?key)(["']?\s*[:=]?\s*["']?)[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/gi, '$1$2[REDACTED:aws-secret]'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  [/gh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED:github-token]'],
  [/github_pat_[A-Za-z0-9_]{30,}\b/g, '[REDACTED:github-token]'],
  [/npm_[A-Za-z0-9]{30,}\b/g, '[REDACTED:npm-token]'],
  [/gl(?:pat|dt|rt|ptt|soat|cbt|ft|imt|agent)-[A-Za-z0-9_.-]{20,}/g, '[REDACTED:gitlab-token]'],
  [/\bhf_[A-Za-z0-9]{30,}\b/g, '[REDACTED:huggingface-token]'],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, '[REDACTED:stripe-key]'],
  [/\bwhsec_[A-Za-z0-9]{24,}\b/g, '[REDACTED:stripe-key]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED:slack-token]'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED:api-key]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED:google-key]'],
  // Azure storage / service bus connection strings, SAS signatures
  [/\b(AccountKey|SharedAccessKey|SharedAccessSignature)=[^;\s"']{8,}/gi, '$1=[REDACTED:azure-key]'],
  [/([?&]sig=)[A-Za-z0-9%+/=]{20,}/g, '$1[REDACTED:azure-sas]'],
  // scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, '$1:[REDACTED]@'],
  // KEY="value with spaces" / "key": "value" for secret-looking keys (whole quoted value)
  [/\b([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|auth|credential|session)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(["'])(?:(?!\3)[^\n]){4,}\3/gi, '$1$2$3[REDACTED]$3'],
  // KEY=value for secret-looking keys
  [/\b([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|auth|credential|session)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)(?!\[REDACTED)([^\s"',;}{]{4,})/gi, '$1$2[REDACTED]'],
];
const AWS_KEY_ID = /AKIA|ASIA|aws/i; // a key id (even masked) or an AWS context nearby
const AWS_SECRET_BARE = /(?<![A-Za-z0-9/+=])(?=[A-Za-z0-9/+]*[a-z])(?=[A-Za-z0-9/+]*[A-Z])(?=[A-Za-z0-9/+]*[0-9])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g;
// generic bearer-style credential: one long unbroken token with upper + lower + digits and high entropy
const GENERIC = /(?<![A-Za-z0-9_+=-])[A-Za-z0-9_+=-]{32,}(?![A-Za-z0-9_+=-])/g;
export function entropy(s) {
  const n = new Map();
  for (const c of s) n.set(c, (n.get(c) || 0) + 1);
  let h = 0;
  for (const v of n.values()) { const p = v / s.length; h -= p * Math.log2(p); }
  return h;
}
function generic(m) {
  if (!/[a-z]/.test(m) || !/[A-Z]/.test(m) || !/[0-9]/.test(m)) return m; // hex hashes, identifiers, words
  if ((m.match(/[0-9]+/g) || []).length < 3) return m; // CamelCaseNames123: digits of random tokens are scattered
  return entropy(m) >= 4.3 ? '[REDACTED:high-entropy]' : m;
}

let envValues = null;
function sensitiveEnv() {
  if (envValues) return envValues;
  envValues = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!v || v.length < 8 || k === 'PWD' || k === 'OLDPWD' || /^(?:[A-Za-z]:[\\/]|\/)/.test(v) || /^\d+$/.test(v)) continue; // paths and plain numbers are not secrets
    if (/secret|token|passw|pwd|api_?key|access_?key|private|auth|credential|session|cookie|dsn|database_url|conn/i.test(k)) envValues.push(v);
  }
  envValues.sort((a, b) => b.length - a.length);
  return envValues;
}
export function resetRedactionCache() { envValues = null; }

// ANSI CSI/OSC, C0 (except \t \n), DEL, C1, soft hyphen, bidi marks/overrides/isolates, zero-width
// and invisible fillers, variation selectors, interlinear annotations, and the Unicode TAG block
// U+E0000–E007F (invisible to people, read by LLMs: "ASCII smuggling" – SECURITY N7)
const CONTROL = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f-\x9f\xad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
const LINE_SEP = /[\u2028\u2029]/g; // would start a new "line" for a reader, not for JSON/log framing
export function sanitize(s) { return typeof s === 'string' ? s.replace(CONTROL, '').replace(LINE_SEP, ' ') : s; }

export const MAX_STRING = 8000;
const MAX_SCAN = 64000; // bound for the pattern pass; far above MAX_STRING, so no token is split at the cap
export function redact(s) {
  if (typeof s !== 'string') return s;
  let out = sanitize(s);
  if (out.length < 8) return out;
  // redact BEFORE truncating: a cut at MAX_STRING must not leave a token prefix (N7)
  if (out.length > MAX_SCAN) out = out.slice(0, MAX_SCAN);
  for (const v of sensitiveEnv()) if (out.includes(v)) out = out.split(v).join('[REDACTED:env]');
  const aws = AWS_KEY_ID.test(out);
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  if (aws) out = out.replace(AWS_SECRET_BARE, '[REDACTED:aws-secret]');
  out = out.replace(GENERIC, generic);
  if (out.length > MAX_STRING) out = out.slice(0, MAX_STRING) + '…[truncated]';
  return out;
}

/** Deep copy with every string AND every object key redacted + sanitised (ids/paths never match in practice). */
export function redactDeep(x, depth = 0) {
  if (typeof x === 'string') return redact(x);
  if (!x || typeof x !== 'object' || depth > 12) return x;
  if (Array.isArray(x)) return x.map((v) => redactDeep(v, depth + 1));
  const o = {};
  for (const k in x) o[redact(k)] = redactDeep(x[k], depth + 1);
  return o;
}

/** The form of a test id that leaves the engine (events, MCP answers, state.json keys). */
export const outId = (id) => redact(String(id));
