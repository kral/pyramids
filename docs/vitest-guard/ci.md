# CI

Principles:

- The gate is Vitest's own exit code. Plain `vitest run` with a wrapped config uses the fast mode and puts the
  committed quarantine into forks; it needs no vitest-guard CLI call.
- PRs run the fast mode. A nightly job runs the isolated reference suite and `vitest-guard verify`.
- Quarantine files are committed and reviewed (CODEOWNERS recommended). A CI job never commits them: it fails and
  tells the developer to run `check` locally.
- `@kral/vitest-guard` is not on npm yet. The jobs below check out the vto repository at a pinned commit and install
  the tarball. Replace `<OWNER>/<VTO_REPO>` and `<VTO_SHA>`; pin actions by SHA in real use. The examples were
  written from the CLI's documented behaviour and not executed on a hosted runner (unverified there).

Exit codes to gate on (`vitest-guard`): 0 ok, 1 failures, 2 usage/config, 4 quarantine changed, 5 false green. Treat any
other non-zero as failure.

## GitHub Actions

```yaml
name: tests
on:
  pull_request:
  schedule: [{ cron: '17 2 * * *' }]
permissions: { contents: read }
env:
  VTO_SHA: <VTO_SHA>
jobs:
  fast:                                   # pull requests: fast mode, quarantined files in forks
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { persist-credentials: false }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - uses: actions/checkout@v4
        with: { repository: <OWNER>/<VTO_REPO>, ref: '${{ env.VTO_SHA }}', path: .vto-tool, persist-credentials: false }
      - run: |
          npm pack ./.vto-tool/vitest-guard --pack-destination "$RUNNER_TEMP"
          npm i --no-save "$RUNNER_TEMP"/kral-vitest-guard-*.tgz
      - run: npx vitest run               # exit code = the gate; wrapped config, VITEST_GUARD_MODE unset
      # optional: detect a newly vm-incompatible test (exit 4 = would change the quarantine)
      # - run: node node_modules/@kral/vitest-guard/bin/vitest-guard.mjs check

  nightly:                                # whole suite isolated + false-green hunt
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { persist-credentials: false }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - uses: actions/checkout@v4
        with: { repository: <OWNER>/<VTO_REPO>, ref: '${{ env.VTO_SHA }}', path: .vto-tool, persist-credentials: false }
      - run: |
          npm pack ./.vto-tool/vitest-guard --pack-destination "$RUNNER_TEMP"
          npm i --no-save "$RUNNER_TEMP"/kral-vitest-guard-*.tgz
      - run: npx vitest run
        env: { VITEST_GUARD_MODE: isolated }  # reference: Vitest default isolation
      - run: node node_modules/@kral/vitest-guard/bin/vitest-guard.mjs verify --sample all
        # exit 5 = false green, 4 = order-dependent / quarantine would change, 1 = failures
      - run: node node_modules/@kral/vitest-guard/bin/vitest-guard.mjs check --prune
        # exit 4 = quarantine changed (an entry could be released or added): open a PR with the diff
```

Note: a job whose step exits non-zero fails; to turn exit 4 of the nightly into a PR instead of a red build, add
`continue-on-error: true` to that step and upload `.vitest-guard/*.json` as an artifact. Windows and macOS runners work
the same way (use `shell: bash` for the `$RUNNER_TEMP` lines, or PowerShell equivalents).

## Azure Pipelines

```yaml
trigger: none
pr: [main]
schedules:
  - cron: '17 2 * * *'
    displayName: nightly isolated + verify
    branches: { include: [main] }
    always: true
resources:
  repositories:
    - repository: vto
      type: git
      name: <PROJECT>/<VTO_REPO>
      ref: <VTO_SHA_OR_TAG>
pool: { vmImage: ubuntu-latest }
steps:
  - checkout: self
  - checkout: vto
  - task: NodeTool@0
    inputs: { versionSpec: '22.x' }
  - script: npm ci
    workingDirectory: $(Build.SourcesDirectory)/app
  - script: |
      npm pack ../vto/vitest-guard --pack-destination "$(Agent.TempDirectory)"
      npm i --no-save "$(Agent.TempDirectory)"/kral-vitest-guard-*.tgz
    workingDirectory: $(Build.SourcesDirectory)/app
    displayName: install vitest-guard from the pinned vto checkout
  # pull request: fast mode
  - script: npx vitest run
    workingDirectory: $(Build.SourcesDirectory)/app
    condition: and(succeeded(), ne(variables['Build.Reason'], 'Schedule'))
    displayName: tests (vitest-guard fast mode)
  # nightly: reference + verify
  - script: npx vitest run
    workingDirectory: $(Build.SourcesDirectory)/app
    env: { VITEST_GUARD_MODE: isolated }
    condition: and(succeeded(), eq(variables['Build.Reason'], 'Schedule'))
    displayName: tests (isolated reference)
  - script: node node_modules/@kral/vitest-guard/bin/vitest-guard.mjs verify --sample all
    workingDirectory: $(Build.SourcesDirectory)/app
    condition: and(succeeded(), eq(variables['Build.Reason'], 'Schedule'))
    displayName: vitest-guard verify (exit 5 = false green, 4 = quarantine changes)
```

With two `checkout:` steps, sources land in `$(Build.SourcesDirectory)/<repo name>`; adjust the `app` and `vto`
folder names to your repository names.

## Choosing what to gate on

| gate | when |
|---|---|
| `vitest run` (fast, wrapped config) | every PR |
| `vitest-guard check` exit 0 | optional PR job to see that nobody added a mode-incompatible test (exit 4 = commit the new quarantine locally) |
| `VITEST_GUARD_MODE=isolated vitest run` | nightly and before release; always for security-critical tests |
| `vitest-guard verify --sample all` | nightly; required before gating on `shared` (the config warns while no clean record exists for the commit) |
| `vitest-guard check --prune` | weekly; releases files that pass fast again |

Caching: `.vitest-guard/run/` is volatile; caching it between runs is optional (it holds durations that make plans
better, and `files-cache.json`, which self-invalidates).

The verify record is tied to the commit and a hash of config + quarantine files, so the shared-mode warning of
`vitest run` appears in CI when the record (git-ignored, under `run/`) is absent. Silence with
`VITEST_GUARD_VERIFY_WARNING=0` in jobs where the nightly verify is the control.
