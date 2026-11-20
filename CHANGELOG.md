# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-20

First release. Verified end to end with Kiro CLI 2.27.1 on Windows 11.

### Added

- **MCP server** (`uab mcp`, stdio) for the ChatGPT desktop app with 31 tools for sessions,
  agents, read-only project inspection, tasks, approvals and results, and server instructions
  that mark agent output as untrusted. No shell or file-write tool.
- `uab mcp-config` generates the `[mcp_servers.uab]` block for `~/.codex/config.toml`.
- **Tasks and approvals**: immutable prompt versions with a fixed rules header, SHA-256 binding,
  single-use expiring approvals, reject / request changes / revise, local approval by default
  (`uab approve`) and opt-in chat approval, append-only audit log.
- **Execution manager**: background runs, prompt on stdin, no shell, timeouts, cancel with
  process-tree kill, one writer per working tree, crash recovery (`interrupted`, never
  restarted), redacted and capped output, resume of native agent conversations per session.
- **Results**: final message, agent-reported success, permission denials, errors, changed files
  (with pre-existing changes marked), diff stat, commits created, and UAB's own verification
  command (`uab project set-test`) with test summary parsing.
- **Agent execution adapters** for Kiro CLI (verified), Claude Code, OpenCode and Codex CLI;
  `uab agents setup kiro` installs project-confined Kiro profiles.
- Secret redaction and sensitive-file filtering for logs, results and diffs.
- CLI: `pending`, `approve`, `reject`, `request-changes`, `tasks`, `task show|run|result|logs|cancel`,
  `audit`, `project set-test|clear-test`, `agents setup kiro`, `mcp`, `mcp-config`.
- Config: `agents.<id>.profile|model|allowTools`, `execution.verifyTimeoutMinutes`.
- Docs: complete README, `docs/security.md`, `docs/troubleshooting.md`, updated
  `docs/supported-agents.md` and `docs/architecture.md`; `CONTRIBUTING.md`, `SECURITY.md`,
  issue and pull request templates.

### Phase 3

- Agent definition contract and registry: detection, version and native login status.
- Bounded process runner and Windows npm wrapper resolution; per-agent forbidden flags.
- `uab agents list|status`, config `agents.<id>.enabled|executable`.

### Phase 2

- SQLite database with checksummed migrations and automatic backups.
- Project registration with symlink-aware path validation.
- Sessions bound to one project and agent, protected by hashed tokens; `uab session …`.

### Phase 1

- Research and gap analysis, architecture, project foundation (TypeScript, ESLint, Prettier,
  Vitest, CI), configuration and error codes.
