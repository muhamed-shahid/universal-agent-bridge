# Troubleshooting

Start with these three commands; they answer most questions:

```bash
uab config          # data directory, config file, effective settings
uab agents status   # installed? logged in? version?
uab db status       # database file and schema version
```

## ChatGPT desktop app

| Problem                                                    | Cause and fix                                                                                                                                                                                                                                 |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uab` missing under `/mcp`                                 | The `[mcp_servers.uab]` block is not in the file the app reads. Run `uab mcp-config`; its first line names the file. Check the TOML has only one `[mcp_servers.uab]` table. Quit the app fully and reopen it.                                 |
| `uab` listed but shows an error                            | Copy `command` and `args` from the block and run them in a terminal. If it prints an error (for example `Cannot find module …dist/cli.js`), run `npm run build` in the UAB folder. If it waits silently, the server is fine (Ctrl+C to stop). |
| Tools listed in `/mcp` but ChatGPT says it cannot see them | Known issue [openai/codex#38162](https://github.com/openai/codex/issues/38162) on some Windows/Plus setups for plain Chat. Use a thread that runs locally (Work or Codex).                                                                    |
| ChatGPT forgets the session                                | It needs the session id and token in the same conversation. Paste them again, or run `uab session rotate-token <id>` and give it the new token.                                                                                               |
| ChatGPT and your terminal show different data              | They use different data directories. Use the same `UAB_HOME` in both: `uab mcp-config --uab-home <path>`.                                                                                                                                     |
| Tool calls time out                                        | `tool_timeout_sec` (120 s in the generated block) applies to single tool calls. Agent runs are asynchronous, so this should not happen; raise it if your disk is very slow.                                                                   |

## Approvals and tasks

| Error                                            | Meaning and fix                                                                                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APPROVAL_REQUIRED`                              | Not approved yet. Run `uab pending`, then `uab approve <task-id>`.                                                                                               |
| `APPROVAL_CHANNEL_LOCAL_ONLY`                    | ChatGPT tried to approve. Approve in the terminal.                                                                                                               |
| `APPROVAL_MISMATCH`                              | The prompt changed after it was shown (a new version exists). Review again with `uab approve <task-id>`.                                                         |
| `APPROVAL_EXPIRED`                               | More than `approval.expiryMinutes` passed. Ask ChatGPT to propose the task again.                                                                                |
| `APPROVAL_ALREADY_USED`                          | The task already ran or finished. Every new piece of work is a new task.                                                                                         |
| `WORKTREE_BUSY`                                  | Another write task is running in the same directory. `uab tasks --status running` shows it; wait or `uab task cancel <id>`.                                      |
| `TASK_NOT_FOUND` from ChatGPT                    | The task belongs to another session (or the id is wrong).                                                                                                        |
| Task `interrupted`                               | UAB stopped (for example the ChatGPT app restarted) while the agent ran. It is never restarted automatically. Check `uab task logs <id>` and propose a new task. |
| `uab approve` says "Not an interactive terminal" | Your terminal does not allow input (for example inside some IDE task runners). Review the printed prompt and use the `--sha256 … --yes` command it shows.        |

## Agents

| Problem                                                           | Fix                                                                                                                                                                                                                  |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kiro: `Mode 'uab-write' not found`                                | `uab agents setup kiro`.                                                                                                                                                                                             |
| Kiro: task `permission_denied`                                    | Headless Kiro refuses tools that are not pre-approved (shell, web, files outside the project). Use `uab project set-test` for tests, or point `agents.kiro.profile` at your own Kiro agent with the tools you trust. |
| Claude: `could not authenticate with its provider (HTTP 401/403)` | Run `claude` in a terminal and fix the login or API key. `uab agents status claude` only shows what is configured.                                                                                                   |
| Claude: task `permission_denied` for Bash                         | Add a scoped rule: `"agents": { "claude": { "allowTools": ["Bash(npm test:*)"] } }`.                                                                                                                                 |
| OpenCode: provider error in `errors`                              | The provider rejected the request (credit, key, model). Fix it with `opencode providers login` and test `opencode run "hi"` yourself.                                                                                |
| `Not installed` although the CLI works in your terminal           | UAB searches absolute `PATH` entries only. Set `agents.<id>.executable` to the full program path.                                                                                                                    |
| `wrapper script UAB cannot run without a shell`                   | Point `agents.<id>.executable` at the real `.exe` (often in `node_modules\<package>\bin`).                                                                                                                           |

## Database

| Problem                    | Fix                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_TOO_NEW`         | The database was upgraded by a newer UAB. Upgrade UAB.                                                                              |
| `DATABASE_SCHEMA_MISMATCH` | The database does not match this UAB build. Restore a backup (`uab.db.v<N>-*.bak` in the data directory) or use a fresh `UAB_HOME`. |
| `database is locked`       | Another long write is running. It waits up to 5 s; retry.                                                                           |

## Getting more detail

Set `UAB_LOG_LEVEL=debug`. For the MCP server, add to the config block:

```toml
[mcp_servers.uab.env]
UAB_LOG_LEVEL = "debug"
```

Logs go to stderr (the ChatGPT app shows them in its MCP logs). `uab audit` lists every
proposal, decision, dispatch and result.
