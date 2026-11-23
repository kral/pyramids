# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**Security → Report a vulnerability** on this repository
([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).
Do not open a public issue for security problems.

Please include the version or commit, your OS and Node/Vitest versions, and steps to reproduce. We aim to
acknowledge reports within 7 days and to agree on a disclosure date with you.

## Supported versions

`@jirikral/vitest-guard` is alpha (pre-1.0). Only the latest release on the npm dist-tag `next` and the latest
commit on `main` receive security fixes.

## Scope and threat model

vitest-guard runs your project's tests, so it executes code from the repository it is pointed at, the same trust
level as `npm test`. Running it on an untrusted checkout is not a supported configuration. In scope are, for
example: commands that execute repository code although documented otherwise, writes outside the project's
`.vitest-guard/` directory, following links out of it, injection into reports, terminals or git invocations,
fast-mode runs that report a false green, and supply-chain issues in published artifacts.

`vitest-guard` modes `vm` and `shared` are performance modes, not a security sandbox. The state-directory rules
are described in [docs/vitest-guard/security.md](docs/vitest-guard/security.md).
