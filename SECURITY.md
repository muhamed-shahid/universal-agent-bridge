# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private
[security advisory](../../security/advisories/new) form for this repository.

Include the UAB version (`uab --version`), your OS, the coding CLI and version involved, and
steps to reproduce. Do not include real credentials, tokens or private code.

We aim to acknowledge reports within 7 days.

## Scope

In scope: anything that lets a task run without the user's approval, lets one session reach
another session's data, escapes the project directory through UAB's own tools, leaks secrets
through UAB's results or logs, or makes UAB pass a permission-bypass flag to an agent.

Out of scope: what a coding agent does under permissions the user configured, and the security
of the ChatGPT app or the coding CLIs themselves (report those to their vendors).

See [docs/security.md](docs/security.md) for the threat model.
