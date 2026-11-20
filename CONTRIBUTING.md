# Contributing

Thanks for helping. Bug reports, agent integrations, documentation fixes and tests are all
welcome.

## Setup

```bash
git clone <repository-url>
cd universal-agent-bridge
npm install
npm run check
```

Requirements: Node.js 22.13 or later, Git. The test suite needs no coding CLI and no provider
account. Use a scratch data directory while developing (`UAB_HOME=<absolute path>`).

## Pull requests

- Create a branch from `main`; keep each PR focused.
- `npm run check` must pass (typecheck, lint, format, build, tests).
- Add tests for behaviour changes. Security-relevant changes need a test in `tests/security`.
- Update `README.md`, `docs/` and `CHANGELOG.md` when user-visible behaviour changes.
- Never commit real credentials, tokens, personal paths or private repository data. Use
  generic paths such as `C:\Projects\MyProject` and fake values in tests.

## Rules that keep UAB safe

- No shell: start processes only with `runProcess` and argument arrays.
- No new path to `running` except `TaskService.claimForDispatch`.
- No MCP tool may run commands or write files directly.
- Adapters must not emit any flag in their `forbiddenArgs`, and must send the prompt on stdin.
- Probes and parsers must not return raw CLI output, emails, account ids, URLs or keys.
- Never edit a released database migration; add a new one.

## Adding a coding agent

See [docs/development.md](docs/development.md#adding-a-coding-agent). In short: add an
`AgentDefinition` with detection probes, forbidden flags and an `execution` adapter, register it
in `BUILTIN_AGENTS`, add parser tests with anonymised real output, and document it in
`docs/supported-agents.md` with the version you verified.

## Code of conduct

Be respectful and constructive. Harassment is not tolerated.
