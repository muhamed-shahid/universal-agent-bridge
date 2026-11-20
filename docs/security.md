# Security model

UAB lets a chat assistant start programs that edit code on your computer. This document lists
what UAB protects against, how, and what it does not protect against.

## Trust boundaries

| Source                                         | Trusted? | Notes                                                                 |
| ---------------------------------------------- | -------- | --------------------------------------------------------------------- |
| You at the local terminal (`uab` CLI)          | Yes      | Approvals, project registration, test commands, token rotation.       |
| UAB config file                                | Yes      | Stored in your user data directory.                                   |
| ChatGPT (MCP tool calls)                       | **No**   | Prompts, paths and ids are validated and checked against the session. |
| Coding agent output, project files, git output | **No**   | Stored redacted, returned as data, labelled untrusted.                |

## Threats and controls

| Threat                                          | Control                                                                                                                                                                                                                                 | Code                                                |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| ChatGPT runs a task you did not approve         | Tasks can only reach `running` through `claimForDispatch`, which needs an unconsumed, unexpired approval bound to session, agent, project path, prompt version and SHA-256, consumed in the same transaction that creates the execution | `src/tasks/service.ts`, `src/execution/manager.ts`  |
| ChatGPT approves its own task                   | Default `approval.channel = local`: the MCP `approve_task` tool refuses; only `uab approve` approves                                                                                                                                    | `TaskService.approve`                               |
| Prompt changed after you read it                | Approval is bound to the hash of the text shown; a revision creates a new version and returns the task to `pending_approval`                                                                                                            | `TaskService.revise`, `uab approve`                 |
| Replay of an approval                           | Single use (`consumed_at`), unique index per task version, one execution per task                                                                                                                                                       | migration 2                                         |
| Another conversation reads or runs your tasks   | Every session-scoped tool needs session id **and** token; tokens are 256-bit, stored as SHA-256, compared in constant time; tasks are filtered by session; wrong id and wrong token give the same error                                 | `src/sessions/`, `TaskService.#owned`               |
| Agent weakened to "allow everything"            | Per-agent deny list of bypass flags, checked before every spawn; no adapter emits them                                                                                                                                                  | `src/agents/args.ts`, adapters                      |
| Shell injection through prompts                 | No shell anywhere; prompts go to stdin; `.cmd`/`.bat` wrappers are unwrapped, never executed                                                                                                                                            | `src/execution/process.ts`, `src/agents/resolve.ts` |
| PATH hijacking from the project                 | Relative PATH entries are ignored                                                                                                                                                                                                       | `searchPath`                                        |
| Reading files outside the project               | Inspection tools resolve paths with `realpath` and reject `..`, absolute paths, device names and symlink escapes; agents are confined by their own sandbox/profile                                                                      | `src/security/paths.ts`                             |
| Registering a dangerous directory               | Filesystem roots, home directory or its parents, UNC/device paths and the UAB data directory are refused                                                                                                                                | `validateProjectRoot`                               |
| Secret leakage through results                  | Redaction of known key formats, bearer tokens, private keys, URL credentials, secret assignments and secret-looking env values; sensitive files excluded from diffs                                                                     | `src/security/redact.ts`                            |
| Runaway agent                                   | Timeout, cancel, process-tree kill, output caps                                                                                                                                                                                         | `ExecutionManager`, `runProcess`                    |
| Two agents editing one working tree             | Write lock per canonical project path (`WORKTREE_BUSY`)                                                                                                                                                                                 | `worktree_locks`                                    |
| Prompt injection from agent output              | Results are labelled untrusted; server instructions tell ChatGPT not to follow them; nothing in output can trigger an action without a new human approval                                                                               | `src/mcp/server.ts`                                 |
| Crash leaves a task half-done and it runs again | Interrupted executions are marked `interrupted`, never restarted                                                                                                                                                                        | `ExecutionManager.recover`                          |
| Tampering with history                          | `audit_events` is append-only (database triggers)                                                                                                                                                                                       | migration 2                                         |

## What UAB does not protect against

- **The agent's own permissions are the real limit on what a running agent can do.** If you
  configure a CLI to allow everything, UAB cannot stop it. In particular OpenCode's default
  agent may edit files and run commands without asking; configure its `permission` settings.
- **Approving a harmful prompt.** UAB shows you exactly what will be sent; read it.
- **Deliberate sharing of a session token** with another conversation or person.
- **Malware already running as your user**, which can read the UAB database like any other file.
- **Chat approval mode** (`approval.channel = "chat"`) relies on ChatGPT asking you before calling
  `approve_task`. It is weaker than local approval and off by default.
- Redaction is pattern-based and can miss unusual secret formats.

## Data stored

The SQLite database (`<data dir>/uab.db`) contains projects, sessions (token hashes only),
tasks with their prompts, approvals, redacted agent output, results and the audit log. It never
contains provider credentials. On macOS and Linux the file is created with mode `0600`; on
Windows it is protected by your user profile's permissions.

Report vulnerabilities as described in [SECURITY.md](../SECURITY.md).
