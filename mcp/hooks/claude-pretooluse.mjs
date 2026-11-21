#!/usr/bin/env node
// Claude Code PreToolUse hook (matcher "Bash" or "Bash|PowerShell" on Windows): steers full test runs to the vto MCP tools.
//
// Security (SECURITY-REVIEW F3): this hook NEVER returns "allow" and NEVER rewrites the command.
// It only DENIES – with a one-line hint – commands that match a strict grammar exactly:
//     npx vitest run | npx vitest | npm test | npm run test | pnpm test | pnpm vitest run | yarn test | yarn vitest run
// optionally followed by plain test-file paths (letters, digits, _ . / @ -, optional :line).
// Anything else (options, quotes, $, `, ;, |, &, <, >, newlines, env assignments, other tools) → exit 0
// with no output, i.e. the normal permission flow decides. It is a convenience, not a security control.
//
// Opt out per command: set VTO_HOOK=off in the hook's environment, or prefix nothing – the agent can
// still run Vitest by adding any option (e.g. `npx vitest run --reporter=default`), which this
// hook deliberately does not touch.
import { fileURLToPath } from 'node:url';

export const SAFE = /^(?:npx vitest(?: run)?|npm(?: run)? test|pnpm(?: run)? test|pnpm vitest(?: run)?|yarn(?: run)? test|yarn vitest(?: run)?)(?: [A-Za-z0-9_./@-]+(?::\d+)?)*$/;

export function decide(input) {
  if (process.env.VTO_HOOK === 'off') return null;
  if (!input || (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell')) return null; // Windows: Claude Code may use its PowerShell tool
  const cmd = input.tool_input?.command;
  if (typeof cmd !== 'string' || cmd.length > 500) return null;
  if (!SAFE.test(cmd)) return null;
  if (/ -/.test(cmd)) return null; // an option anywhere: not ours
  const files = cmd.split(' ').slice(cmd.startsWith('npx vitest run') || / vitest run/.test(cmd) ? 3 : 2).filter((x) => /\//.test(x) || /\.(test|spec)\./.test(x));
  const hint = files.length
    ? 'vto: use the MCP tool run_tests with filters [{file}] for these files (warm, compact output, map kept up to date).'
    : 'vto: use the MCP tool run_affected instead (runs only the affected tests, compact output); start_run + next_failures for long runs.';
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: hint } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let s = '';
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) { s += c; if (s.length > 1 << 20) process.exit(0); }
  let input;
  try { input = JSON.parse(s); } catch { process.exit(0); }
  const d = decide(input);
  if (d) process.stdout.write(JSON.stringify(d) + '\n');
  process.exit(0);
}
