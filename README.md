# vto – faster Vitest runs

vto makes a Vitest suite answer in seconds instead of minutes, for people and for AI agents:

- **Affected tests only** (`vto run`): a per-test coverage map selects the tests a change can reach;
  everything uncertain falls back to the full suite (exit 3), never to a silent skip.
- **Safe fast pools** ([vitest-guard](docs/vitest-guard/index.md)): `vmThreads` or shared workers with
  realm isolation, a quarantine for incompatible files and a check that a fast run is not falsely green.
- **Failures while the run continues**: a daemon streams failures as they happen (`vto ui`, MCP).
- **Small answers for agents** (`vto mcp`): compact results within a token budget.
- **Overlap report** (`vto report overlap`): tests that cover the same code, verified by mutation testing.

Status: **alpha**. `@jirikral/vitest-guard` is on npm under the dist-tag `next` (`npm i -D @jirikral/vitest-guard@next`);
vto itself is used from source. Linux, macOS and Windows are tested in CI
(Node `^22.22.2 || >=24.15.0`, Vitest 4.1 or 5.1).

> Do not run `npx vto` or `npx vitest-guard`: those unscoped npm names are not ours, and whoever owns them would
> run their code on your machine. Use the local copy as shown below; vitest-guard alone: install it from npm as above.

## Quickstart (from source, about 5 minutes)

```sh
git clone https://github.com/kral/vto.git && cd vto
npm ci --ignore-scripts
npm --prefix mcp ci --ignore-scripts
npm --prefix tui ci --ignore-scripts && npm --prefix tui run build   # only for `vto ui`
(cd analyzer && cargo build --release)                               # Rust analyzer; or set VTO_ANALYZER=<path>
node bin/vto.mjs doctor --root /path/to/your-project                  # checks Node, analyzer, Vitest, git
```

Then, in your project (`vto` below means `node /path/to/vto/bin/vto.mjs`; an npm script or a shell alias is
the easiest way):

```sh
vto run --root .          # first run: the whole suite, records the coverage map in .vto/
# … edit a file …
vto run --root .          # only the affected tests; exit 3 means "run everything"
vto ui                    # in a second terminal: live failures, code frames, re-run, copy as AI prompt
```

On Windows use the same commands in PowerShell (`node C:\src\vto\bin\vto.mjs run --root .`).

## Faster pools: vitest-guard

Wrap your config once, then let vitest-guard measure and decide:

```js
// vitest.config.mjs
import { defineVitestGuardConfig } from '@jirikral/vitest-guard';
export default defineVitestGuardConfig({ test: { environment: 'jsdom' } }, { mode: 'auto' });
```

(`vto` = `node /path/to/vto/bin/vto.mjs`; with the npm package alone use `npm run guard -- <command>` instead of `vto guard <command>`;
see [getting-started.md](docs/vitest-guard/getting-started.md).)

```sh
vto guard compare --sample all   # forks vs vm vs shared per project, CPU time, result mismatches
vto guard check                  # runs the fast mode; real failures vs mode-only failures (quarantine)
vto guard verify --mode shared   # proves the fast mode is not falsely green before you gate on it
```

Every command ends with a summary block: verdict, numbers, exit code and the next step. Installation,
modes and CI setup: [docs/vitest-guard/getting-started.md](docs/vitest-guard/getting-started.md).

## AI agents (Claude Code, Cursor, VS Code)

```sh
claude mcp add --scope project --transport stdio vto -- node /path/to/vto/mcp/bin/vto-mcp.mjs
```

The agent then calls `run_affected` instead of `vitest run`, gets failures while the run continues and inspects
one with `why_failed`. An optional Claude Code hook steers `vitest run` to `run_affected`. Setup per platform,
tool reference and measurements: [mcp/README.md](mcp/README.md).

## Is it worth it for my team?

Estimate before installing anything, every input is a flag:

```sh
vto savings estimate --suite-min 3.5 --ci-runs 30 --devs 8 --usd-per-hour 50 --agent-runs 40
```

It prints the monthly CI runner minutes and cost, developer waiting time and agent tokens saved, with the model
shown in `--help`. After a few weeks of use, `vto savings measured` reports what was actually saved
(formulas: [mcp/SAVINGS.md](mcp/SAVINGS.md)).

## CI

`vto ci github` and `vto ci azure` print a pipeline that runs the affected tests on pull requests and the full
suite on the main branch: [docs/ci/](docs/ci/).

## All commands

`vto --help` lists them; `vto <command> --help` explains one. Exit codes are the same for every command
(0 ok, 1 tests failed, 2 usage error, 3 run all, 4 quarantine changed, 5 false green).

## Repository

| directory | what |
|---|---|
| `bin/` | `vto` dispatcher, savings estimate |
| `collector/` | Vite plugin + setup that record per-test coverage (oxc-parser, hit markers) |
| `analyzer/` | Rust CLI: overlap analysis, `affected` selection, map packing |
| `mcp/` | daemon, MCP server, lanes, savings metrics |
| `tui/` | `vto ui` terminal UI (Ink) |
| `vitest-guard/` | safe fast pools for Vitest (`@jirikral/vitest-guard`) |
| `verify/` | mutation check of overlap candidates |
| `contracts/` | cross-component decisions (`DECISIONS.md`) and schemas |
| `docs/` | user documentation |

Design: [ARCHITECTURE.md](ARCHITECTURE.md). Raw data format: [FORMAT.md](FORMAT.md). Open items before 1.0:
[BLOCKERS-1.0.md](BLOCKERS-1.0.md).

## Security and license

Running tests through vto executes your project's code, exactly like `npx vitest`. Report vulnerabilities
privately as described in [SECURITY.md](SECURITY.md).

Licensed under either of [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
