# Supported agents

UAB detects these coding CLIs, checks their login and runs approved tasks with them.

| Agent       | Task execution | Verified end to end                                                                                                     |
| ----------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Kiro CLI    | yes            | **yes**: Kiro CLI 2.27.1, Windows 11 (file created inside the project, write to `../` refused by Kiro, session resumed) |
| Claude Code | yes            | no: stream-json format and the 401 retry event checked against 2.1.220; no successful run (the test key was rejected)   |
| OpenCode    | yes            | no: error events and stdin prompt checked against 1.19.3; no successful run (the test account had no credit)            |
| Codex CLI   | yes            | no: built from the Codex non-interactive documentation; Codex was not installed                                         |

## How tasks run

Every run starts the CLI directly (no shell) in the registered project directory, with the
prompt on stdin, a filtered environment, a timeout and output limits. The task kind decides the
mode: `review`, `summarize` and `diagnose` are **read-only**; `implement`, `fix` and `test` may
change files inside the project.

| Agent       | Read-only task                                                                                            | Write task                                                      | Continue a conversation                |
| ----------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------- |
| Kiro CLI    | `kiro-cli chat --no-interactive --output-format stream-json --agent uab-read`                             | same with `--agent uab-write`                                   | `--resume-id <id>`                     |
| Claude Code | `claude -p --output-format stream-json --verbose --permission-mode dontAsk --allowedTools=Read,Grep,Glob` | `--permission-mode acceptEdits` plus `agents.claude.allowTools` | `--session-id` (new) / `--resume <id>` |
| OpenCode    | `opencode run --format json --dir <project> --agent plan`                                                 | default agent or `agents.opencode.profile`                      | `--session <id>`                       |
| Codex CLI   | `codex exec --json --sandbox read-only -`                                                                 | `--sandbox workspace-write`                                     | `codex exec resume <id>`               |

Each UAB session keeps one native conversation per agent. Switching agents never passes one
agent's conversation to another. `propose_task` with `freshAgentSession: true` starts a new one.

Check what UAB sees on your machine:

```bash
uab agents status          # all agents
uab agents status claude   # one agent
uab agents status --json   # machine-readable
```

Example output:

```text
Kiro CLI     Authenticated (IamIdentityCenter)  2.27.1
Claude Code  Authenticated (api_key_helper)  2.1.220
OpenCode     Authenticated (stored_credentials)  1.19.3
Codex CLI    Not installed
```

## How detection works

For each agent UAB:

1. Looks for the program on `PATH` (or uses `agents.<id>.executable` from the config file).
   On Windows it unwraps npm `.cmd` wrappers to the real program instead of running them
   through `cmd.exe`.
2. Runs the CLI's own version command.
3. Runs the CLI's own login-status command. It never starts a model conversation.

Both commands run in the system temp directory, not in a project, with a 15-second timeout and
a filtered environment. UAB keeps only a state and a short method label from the output. It
does not keep, log or display emails, account ids, URLs, keys or any other output.

**UAB never asks for passwords or API keys.** Each CLI keeps its own login. If a CLI reads a
key from an environment variable, set it in your own environment as that CLI's documentation
describes. `uab agents status` shows only whether the variable is set.

| State                           | Meaning                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Authenticated                   | The CLI reports a login. The label in brackets is the CLI's own method name.                              |
| Not authenticated               | The CLI reports no login. Log in with the command shown.                                                  |
| Installed, login status unknown | The status command failed or printed something UAB did not recognise. UAB never treats this as logged in. |
| Not installed                   | Not found on `PATH`. Install instructions are shown.                                                      |
| Disabled                        | Turned off in the UAB config (`agents.<id>.enabled: false`). Sessions cannot use it.                      |
| Error                           | Found something that cannot be run safely, for example an unrecognised wrapper script.                    |

## Kiro CLI (`kiro`)

|                            |                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Program                    | `kiro-cli`                                                                                                                                                    |
| Version check              | `kiro-cli --version`                                                                                                                                          |
| Login check                | `kiro-cli whoami -f json` (UAB reads `accountType` only)                                                                                                      |
| Install                    | macOS/Linux: `curl -fsSL https://cli.kiro.dev/install \| bash`. Windows 11: see the [installation guide](https://kiro.dev/docs/getting-started/installation/) |
| Log in                     | `kiro-cli login`                                                                                                                                              |
| Environment passed through | `KIRO_API_KEY`, `KIRO_HOME`                                                                                                                                   |
| Verified with              | 2.27.1 on Windows 11                                                                                                                                          |

Never passed by UAB: `--trust-all-tools`, `-a`, and `--trust-tools` with an empty or wildcard
list. An empty `--trust-tools=` trusts all tools in some versions (kirodotdev/Kiro#12037).

Kiro's [headless documentation](https://kiro.dev/docs/cli/headless/) mentions `KIRO_API_KEY`.
Verified with 2.27.1: a normal `kiro-cli login` is enough; the key is optional.

**Setup:** run `uab agents setup kiro` once. It writes `~/.kiro/agents/uab-read.json` and
`uab-write.json`. Both pre-approve no tools and limit file access to `./**` (the project
directory); headless Kiro denies anything else (shell, web, AWS, paths outside the project).
In a verified run Kiro created a file in the project and refused `../outside.txt`. Use
`agents.kiro.profile` to run your own Kiro agent instead.

## Claude Code (`claude`)

|                            |                                                                                                                                                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Program                    | `claude`                                                                                                                                                                                                                                             |
| Version check              | `claude --version`                                                                                                                                                                                                                                   |
| Login check                | `claude auth status --json` (UAB reads `loggedIn` and `authMethod` only; the `--text` form prints the API base URL and is never used)                                                                                                                |
| Install                    | macOS/Linux/WSL: `curl -fsSL https://claude.ai/install.sh \| bash`. Windows PowerShell: `irm https://claude.ai/install.ps1 \| iex`. WinGet: `winget install Anthropic.ClaudeCode` ([setup guide](https://docs.claude.com/en/docs/claude-code/setup)) |
| Log in                     | `claude auth login`, or run `claude` once                                                                                                                                                                                                            |
| Environment passed through | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_PROFILE`, `AWS_REGION`                                                                             |
| Verified with              | 2.1.220 on Windows 11 (npm install)                                                                                                                                                                                                                  |

Never passed by UAB: `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`,
`--permission-mode bypassPermissions`, and `--settings` values that enable a bypass.

## OpenCode (`opencode`)

|                            |                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Program                    | `opencode`                                                                                                                                                                            |
| Version check              | `opencode --version`                                                                                                                                                                  |
| Login check                | `opencode providers list` (UAB reads the credential count only)                                                                                                                       |
| Install                    | macOS/Linux: `curl -fsSL https://opencode.ai/v2/install \| bash`. npm: `npm install -g @opencode/cli`. Windows: standalone binary from the [OpenCode docs](https://opencode.ai/docs/) |
| Log in                     | `opencode providers login`, or `/connect` in the OpenCode TUI                                                                                                                         |
| Environment passed through | `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`                                                                                                                                              |
| Verified with              | 1.19.3 on Windows 11 (npm package `opencode-ai`, OpenCode V1)                                                                                                                         |

Never passed by UAB: `--auto`.

**Permissions:** OpenCode's own `permission` settings apply. Its default agent may edit files and
run commands without asking, so configure `permission` (for example ask for shell commands)
before running write tasks.

Known limitations: providers configured only through environment variables (no stored
credential) are reported as not authenticated. The current OpenCode docs describe V2
(`@opencode/cli`), which changes the permission configuration format; the adapter was checked
against V1 (1.19.3) only.

## Codex CLI (`codex`)

|                            |                                                                                                                                                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Program                    | `codex`                                                                                                                                                                                                                                                                                |
| Version check              | `codex --version`                                                                                                                                                                                                                                                                      |
| Login check                | `codex login status`                                                                                                                                                                                                                                                                   |
| Install                    | macOS/Linux: `curl -fsSL https://chatgpt.com/codex/install.sh \| sh`. Windows PowerShell: `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 \| iex"`. npm: `npm install -g @openai/codex` ([Codex CLI docs](https://learn.chatgpt.com/docs/codex/cli)) |
| Log in                     | `codex login`                                                                                                                                                                                                                                                                          |
| Environment passed through | `CODEX_HOME`, `CODEX_API_KEY`, `OPENAI_API_KEY`                                                                                                                                                                                                                                        |
| Verified with              | **Not verified.** Codex was not installed on the development machine; detection follows the documentation.                                                                                                                                                                             |

Never passed by UAB: `--sandbox danger-full-access` (and `-s`), `--yolo`,
`--dangerously-bypass-approvals-and-sandbox`, and `-c`/`--config` overrides containing
`danger-full-access`.

## Configuration

In the UAB config file (`uab config` shows its location):

```json
{
  "agents": {
    "codex": { "enabled": false },
    "claude": { "executable": "C:\\Tools\\claude\\claude.exe", "allowTools": ["Bash(npm test:*)"] },
    "kiro": { "profile": "uab-write", "model": "claude-sonnet-4" }
  }
}
```

- `enabled: false` hides the agent from sessions and skips its checks.
- `executable` must be an absolute path to the program (or an npm `.cmd` wrapper UAB can
  unwrap). Use it when the CLI is not on `PATH` or is installed in an unusual way.
- Unknown agent ids and unknown keys are rejected.

## Troubleshooting

| Problem                                                | What to do                                                                                                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Not installed` but the CLI works in your terminal     | UAB searches only absolute `PATH` entries. Run `where <program>` (Windows) or `command -v <program>` and set `agents.<id>.executable` to that path.                                                          |
| `Error`: wrapper script UAB cannot run without a shell | The CLI was installed with a launcher script UAB does not recognise. Point `agents.<id>.executable` at the real `.exe` (often in `node_modules\<package>\bin`).                                              |
| `Installed, login status unknown`                      | Run the login check command from the table yourself. If it prompts or fails, log in with the CLI first. A newer CLI may have changed its output; please open an issue with the CLI version (not the output). |
| `... did not finish within 15 s`                       | The CLI's status command hung, often waiting for network or a first-run prompt. Run the CLI once interactively.                                                                                              |
