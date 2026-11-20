# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added in Phase 3

- Agent definition contract (`src/agents/types.ts`) and `AgentRegistry`: detection of installed
  coding CLIs, version, and login status from each CLI's own status command, with states
  `ready`, `not_installed`, `not_authenticated`, `auth_unknown`, `disabled` and `error`.
- Built-in definitions for Kiro CLI, Claude Code, OpenCode and Codex CLI (detection only),
  with install and login guidance from each vendor's documentation.
- Per-agent deny lists of arguments that weaken native permission checks, and
  `assertSafeArgs` to enforce them.
- Bounded process runner: no shell, explicit environment allowlist, stdin input, output caps,
  timeout and abort that kill the whole process tree.
- Windows program resolution that unwraps npm `.cmd` wrappers instead of running `cmd.exe`,
  and ignores relative `PATH` entries.
- CLI: `uab agents list`, `uab agents status [<agent>] [--json]`.
- Config section `agents.<id>.enabled|executable`; sessions accept only enabled agents.
- Error codes `AGENT_DEFINITION_INVALID`, `FORBIDDEN_AGENT_ARGUMENT`.
- `docs/supported-agents.md`; mock CLI fixture for tests.

### Added in Phase 2

- Phase 2: SQLite database (`node:sqlite`, WAL) with numbered, checksummed migrations, a backup
  before each upgrade, and refusal to open newer or modified schemas.
- Project registration with path validation: absolute, existing directories only; symlinks,
  junctions and letter case resolved; home directory, filesystem roots, UNC/device paths and
  the UAB data directory refused.
- Project-relative path guard with symlink-aware containment checks (for later inspection
  tools).
- Session manager: create, list, get, resume, close, switch agent and history, each session
  bound to one project and protected by a token stored only as a SHA-256 hash.
- CLI commands: `project add|list|remove`, `session create|list|show|history|close|rotate-token`,
  `db status|backup`.
- Config setting `projects.allowMcpRegistration` (default `false`).
- Error codes `DATABASE_ERROR`, `DATABASE_MIGRATION_FAILED`, `DATABASE_SCHEMA_MISMATCH`,
  `DATABASE_TOO_NEW`, `PROJECT_NOT_FOUND`, `PROJECT_IN_USE`.
- `docs/development.md`.

### Changed

- Continuing a session in a new conversation uses `uab session rotate-token` (the design
  previously named `uab session token`, which cannot work because only the token hash is
  stored).

### Added in Phase 1

- Research and gap analysis (`docs/research-and-gap-analysis.md`) and architecture
  (`docs/architecture.md`).
- Project foundation: TypeScript, ESLint, Prettier, Vitest, GitHub Actions CI.
- Core modules: validated configuration (`src/core/config.ts`), error codes
  (`src/core/errors.ts`), data-directory resolution (`src/core/paths.ts`), stderr logger.
- `uab` CLI with `config`, `help` and `--version`.
