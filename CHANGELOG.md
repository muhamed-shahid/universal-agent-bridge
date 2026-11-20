# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Phase 1: research and gap analysis (`docs/research-and-gap-analysis.md`) and architecture
  (`docs/architecture.md`).
- Project foundation: TypeScript, ESLint, Prettier, Vitest, GitHub Actions CI.
- Core modules: validated configuration (`src/core/config.ts`), error codes
  (`src/core/errors.ts`), data-directory resolution (`src/core/paths.ts`), stderr logger.
- `uab` CLI with `config`, `help` and `--version`.
