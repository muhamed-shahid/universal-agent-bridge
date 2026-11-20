# Supported agents

Status: Phase 3. UAB **detects** these coding CLIs and checks their login. It cannot run tasks
with any of them yet; task execution arrives per agent in Phases 4 (Kiro), 8 (Claude Code),
9 (OpenCode) and 10 (Codex).

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

Known limitation: Kiro's [headless documentation](https://kiro.dev/docs/cli/headless/) says
non-interactive runs authenticate with `KIRO_API_KEY`, available on Pro plans and above.
Phase 4 verifies whether a normal interactive login is enough.

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

Known limitations: providers configured only through environment variables (no stored
credential) are reported as not authenticated. The current OpenCode docs describe V2
(`@opencode/cli`), which changes the permission configuration format; Phase 9 verifies both.

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
    "claude": { "executable": "C:\\Tools\\claude\\claude.exe" }
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
