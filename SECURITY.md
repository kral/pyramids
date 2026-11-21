# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**Security → Report a vulnerability** on this repository
([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).
Do not open a public issue for security problems.

Please include the affected component (collector, analyzer, vm-guard, daemon/MCP, TUI, verify),
the version or commit, your OS, and steps to reproduce. We aim to acknowledge reports within
7 days and to agree on a disclosure date with you.

## Supported versions

vto is pre-1.0. Only the latest commit on `main` receives security fixes.

## Scope and threat model

vto runs your project's tests, so it executes code from the repository it is pointed at — the same
trust level as `npm test`. Running vto on an untrusted checkout is not a supported configuration.
In scope are, for example: commands documented as read-only that execute repository code,
privilege or data exposure to other local users (daemon IPC, files under `.vto/`), injection into
reports, terminals, git invocations or AI-agent prompts, test-selection results that silently skip
tests that would fail, and supply-chain issues in published artifacts.

`vm-guard` modes `vm` and `shared` are performance modes, not a security sandbox.

The threat model and past findings are documented in `SECURITY-REVIEW.md` and
`REVIEW-2-security.md`.
