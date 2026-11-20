# Research and gap analysis

Status: Phase 1 output. Research date: 2026-11-20. Everything below was checked against
the sources linked in each section on that date. ChatGPT, Codex and the coding CLIs change
often, so each later phase must re-verify the parts it depends on.

## 1. ChatGPT and MCP: what is actually supported

### 1.1 Two different integration paths

| Surface                                         | How it reaches an MCP server                                                                                                                                           | Local stdio server?                                                         | Account requirements                                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **ChatGPT desktop app** (macOS, Windows, Linux) | Runs a local Codex host. MCP servers are configured in the shared Codex config file `~/.codex/config.toml` (`[mcp_servers.<name>]`) or through the app's MCP settings. | **Yes.** stdio and Streamable HTTP.                                         | Any account that can use the desktop app's local threads. Workspace admins can restrict it.                   |
| **ChatGPT web** (chatgpt.com)                   | Plugins → **Add custom MCP server**, with a public HTTPS URL or a Secure MCP Tunnel.                                                                                   | No. A local server needs `openai/tunnel-client` or a public HTTPS endpoint. | Governed by account and workspace policy (Business/Enterprise/Edu admins control "Create plugins with MCPs"). |

Sources:

- Codex/ChatGPT MCP docs: <https://developers.openai.com/codex/mcp> ("The ChatGPT desktop app,
  Codex CLI, and IDE extension support MCP servers and share MCP configuration for the same
  Codex host.")
- Desktop-only plugins: <https://developers.openai.com/plugins/deploy/desktop-only> (local
  stdio plugins are "Desktop only" and "Users can mention them only in threads that run
  locally").
- Connect from ChatGPT web: <https://developers.openai.com/apps-sdk/deploy/connect-chatgpt>
- Secure MCP Tunnel: <https://platform.openai.com/docs/guides/secure-mcp-tunnels>,
  <https://github.com/openai/tunnel-client>

**Decision.** UAB targets the **ChatGPT desktop app with a local stdio MCP server** configured
in `~/.codex/config.toml`. This is the officially documented local path. It requires no public
endpoint, no tunnel and no OAuth server, and it keeps the bridge on the user's machine.
ChatGPT web through Secure MCP Tunnel is a possible later option. It is not planned for the
initial release because it would expose a process-spawning service beyond the local machine.

### 1.2 Verified configuration properties

These are the only `[mcp_servers.<name>]` keys UAB documentation will use for stdio servers. All
of them appear in the official reference above:

`command`, `args`, `env`, `env_vars`, `cwd`, `startup_timeout_sec` (default 10),
`tool_timeout_sec` (default 60), `enabled`, `required`, `enabled_tools`, `disabled_tools`,
`default_tools_approval_mode` (`auto` | `prompt` | `writes` | `approve`),
`tools.<tool>.approval_mode`, `tools.<tool>.output_token_limit`.

Two of these matter for the design:

- `tool_timeout_sec` defaults to 60 seconds. A coding agent run takes minutes, so **tool calls
  must never block on agent execution.** Execution is asynchronous and ChatGPT polls for status.
- `default_tools_approval_mode` and per-tool `approval_mode` let the host ask the user before a
  tool runs. `writes` prompts for every tool that is not annotated read-only. UAB marks its
  tools with accurate MCP `readOnlyHint` / `destructiveHint` annotations so this works.

### 1.3 Write-capable tools and approval prompts

- The desktop host executes non-read-only MCP tools, subject to the approval mode above.
- Approval prompts are rendered by the **host** (ChatGPT), not by the MCP server. A server cannot
  prove to itself that a human clicked "approve" in ChatGPT. It only sees a `tools/call`.
- MCP elicitation (server-initiated prompts to the user) is only partially supported by the
  Codex host. For example, openai/codex#59643 reports a server being rejected for advertising
  `elicitation.form`. UAB must not depend on elicitation.

Consequence: **ChatGPT calling an `approve_task` tool is not, by itself, evidence of human
approval.** The model could call it on its own. See section 5 for how UAB handles this.

### 1.4 Conversation identity: the server does not know which chat called it

openai/codex#54683 (opened 2026-10-16, open at time of writing) documents that the desktop
app hosts every thread in one process, and MCP servers receive no thread id: it is not in the
environment, not in `initialize` (which carries only `clientInfo`), and not in `tools/call`
`_meta`. A later comment reports that some desktop paths do send per-request thread identity,
but this is undocumented and not guaranteed.

Consequence: UAB **must not infer the conversation.** Sessions are created and bound explicitly
(section 5.2).

### 1.5 Known platform issues to track

| Issue                                                                                                                                                                               | Effect on UAB                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| openai/codex#38162: Windows, ChatGPT Plus. Local MCP tools are discovered (`tools/list` succeeds) but not exposed to **Chat** sessions; the same server works from Codex CLI. Open. | On some Windows/Plus setups, ChatGPT "Chat" mode may not see UAB tools. Workaround to document: use a thread that runs locally (Codex/Work mode in the desktop app). Must be verified manually in Phase 7. |
| openai/codex#54683: no thread id for MCP servers.                                                                                                                                   | Explicit session binding (above).                                                                                                                                                                          |
| openai/codex#59643: `elicitation.form` capability rejected.                                                                                                                         | Do not use elicitation.                                                                                                                                                                                    |

### 1.6 What UAB will and will not claim

- Supported: ChatGPT desktop app with a locally configured stdio MCP server.
- Requires manual verification per machine: that the user's plan and workspace policy expose
  local MCP tools in the thread type they use (see #38162).
- Not supported in the initial release: ChatGPT web, ChatGPT mobile, remote or tunnelled access.

## 2. Coding CLIs

Versions inspected locally on Windows 11: Kiro CLI 2.27.1, Claude Code 2.1.220, OpenCode 1.19.3.
Codex CLI was **not installed**, so its findings come from documentation only.

### 2.1 Capability matrix

| Capability                          | Kiro CLI                                                                                                                          | Claude Code                                                                                                                                            | OpenCode                                                                                                     | Codex CLI                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Non-interactive run                 | `chat --no-interactive "<prompt>"` (prompt also via stdin)                                                                        | `-p "<prompt>"`                                                                                                                                        | `run "<message>"`                                                                                            | `exec "<prompt>"`                                                                     |
| Machine-readable output             | `--output-format stream-json` (ACP events as JSON Lines)                                                                          | `--output-format json` / `stream-json`                                                                                                                 | `--format json` (raw JSON events)                                                                            | `--json` (JSONL: `thread.started`, `turn.*`, `item.*`, `error`)                       |
| Session id to resume                | `--resume-id <id>`; list with `chat --list-sessions -f json`                                                                      | `--resume <id>`; caller can set `--session-id <uuid>`                                                                                                  | `--session <id>`; `session` subcommand; `export`                                                             | `exec resume <id>`; id from `thread.started.thread_id`                                |
| Working directory                   | process cwd                                                                                                                       | process cwd; `--add-dir` widens it                                                                                                                     | `--dir <path>`                                                                                               | process cwd / `--cd`                                                                  |
| Native permission model             | Tool trust. Headless denies any untrusted tool: `--trust-tools=<list>`, `--trust-all-tools`, agent configs, V3 `permissions.yaml` | `--permission-mode` (`manual`, `acceptEdits`, `auto`, `dontAsk`, `plan`, `bypassPermissions`), `--allowed-tools`, `--disallowed-tools`, settings files | `permissions` rules in `opencode.jsonc` with `allow` / `deny` / `ask`; default when no rule matches is `ask` | `--sandbox read-only` (default for `exec`) / `workspace-write` / `danger-full-access` |
| Auth check without a model call     | `whoami -f json`                                                                                                                  | `auth status --json`                                                                                                                                   | `providers list`                                                                                             | `codex login status` (to verify in Phase 10)                                          |
| Dangerous flags UAB must never pass | `--trust-all-tools`; an **empty** `--trust-tools=` (see below)                                                                    | `--dangerously-skip-permissions`, `--permission-mode bypassPermissions`, `--allow-dangerously-skip-permissions`                                        | `--auto`                                                                                                     | `--sandbox danger-full-access`, `--yolo`                                              |

Sources: local `--help` output; <https://kiro.dev/docs/cli/headless/>;
<https://docs.claude.com/en/docs/claude-code/sdk/sdk-headless>;
<https://opencode.ai/docs/permissions/>; <https://learn.chatgpt.com/docs/non-interactive-mode>.

### 2.2 Findings that change the design

1. **Kiro headless authentication.** The Kiro headless docs say headless mode requires
   `KIRO_API_KEY`, which is only available on Pro, Pro+, Pro Max and Power plans. It is not
   yet verified whether `--no-interactive` also works with a normal interactive login on
   2.27.1. Phase 4 must test this manually. UAB will not ask for or store the key. If the key
   is required, the user sets it in their own environment.
2. **Kiro trust bug.** kirodotdev/Kiro#12037: an empty `--trust-tools=` trusts tools instead of
   none and lets writes escape `allowedPaths`. The Kiro adapter must never emit an empty
   `--trust-tools` value. A unit test will enforce this.
3. **Headless means "deny unless pre-allowed".** Kiro (untrusted tools), Claude (`dontAsk`) and
   Codex (read-only sandbox) all refuse actions they cannot ask about. This matches the
   requirement to keep native permissions. The consequence is that **an approved task can still
   fail because the agent was not permitted to edit files.** This is correct behaviour, and UAB
   reports it as a distinct status (`permission_denied`) instead of hiding it.
4. **Native permission relays exist.** Every CLI has a programmatic channel that can forward a
   permission request to a client: Kiro ACP, Claude `--permission-prompt-tool` / stream-json
   control messages, OpenCode server permission events, Codex `app-server` approval requests.
   A later phase can surface these Layer-2 requests in the UAB approval queue for a human
   decision. The initial adapters use the simpler one-shot commands with explicit,
   user-configured allowlists.
5. **Session ids differ by agent.** Claude lets the caller choose the id; Codex and OpenCode
   report theirs in the event stream; Kiro lists sessions per directory. The adapter interface
   therefore returns the native session id after the first run rather than requiring it up
   front.

## 3. Existing projects

|                  | ChatCmd (int04/ChatCmd)                                                                                                                                         | MELRA (XAGI-Lab/melra)                                                                                                                                            | multiagents (zetbrush/multiagents)                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Licence          | MIT                                                                                                                                                             | AGPL-3.0-only (SDKs Apache-2.0)                                                                                                                                   | **No licence file** (GitHub reports none)                                                                                     |
| Language         | Rust + React                                                                                                                                                    | TypeScript + Python                                                                                                                                               | TypeScript (Bun)                                                                                                              |
| Last push        | 2026-09-26                                                                                                                                                      | 2026-11-17                                                                                                                                                        | 2026-10-20                                                                                                                    |
| What it is       | Local MCP server exposing machine tools (PTY terminals, files, Git, processes) to MCP clients, plus a Chromium extension that drives chatgpt.com in the browser | A local MCP runtime that checks agent tool calls against policy, gates mutations on approval, verifies evidence and records receipts                              | A broker plus orchestrator that lets Claude Code, Codex and Gemini CLI agents message each other and review each other's work |
| Session model    | Tasks bound to a ChatGPT browser tab and conversation URL, which it can observe because it controls the browser                                                 | Per-task records                                                                                                                                                  | Named sessions in a SQLite broker on `localhost:7899`                                                                         |
| Approval model   | Approval modes and queues in its console; per-tool allowlists on tokenized MCP URLs                                                                             | Exact, expiring, task-scoped approval. In "enforced" mode only an operator approves, out of band, with `melra approve <task-id>`; the agent cannot approve itself | Agent-to-agent review states. Its Codex driver **auto-approves** command, file and permission requests for the session        |
| Relevance to UAB | Proves ChatGPT ↔ local MCP is useful. Its direct terminal and file tools are the model UAB rejects (UAB exposes no shell tool)                                  | Closest match to UAB's approval requirements. Confirms the out-of-band approval pattern and at-most-once dispatch                                                 | Shows how to drive each CLI headlessly. Its approval behaviour is the opposite of UAB's requirement                           |

### 3.1 What they solve

- Local-first MCP bridges with SQLite state (all three).
- Headless driving of Claude Code and Codex (multiagents).
- Policy plus out-of-band human approval with replay protection (MELRA).

### 3.2 What they do not solve for this use case

- None of them treats **ChatGPT desktop as the coordinator and the coding CLIs as executors**
  with a human approval step on every handoff.
- ChatCmd ties sessions to browser tabs. The desktop MCP path has no equivalent identity.
- MELRA governs individual tool calls made through it. It does not dispatch whole tasks to
  third-party coding CLIs or collect their results.
- multiagents optimises for agent autonomy, and it has no licence, so none of its code can be
  reused.
- None of them supports Kiro CLI or OpenCode, or offers a common adapter contract for adding
  new CLIs.

### 3.3 Code reuse

**No code is copied from any of these projects.** MELRA is AGPL, so copying would impose AGPL on
UAB. multiagents has no licence, so no reuse rights exist. ChatCmd is MIT, but it is written in
Rust and solves a different problem. UAB uses only publicly documented ideas (out-of-band
approval, at-most-once dispatch, prompt hashing), which are not copyrightable. UAB is MIT
licensed.

## 4. MCP SDK and stack

| Choice                      | Version                     | Reason                                                                                       |
| --------------------------- | --------------------------- | -------------------------------------------------------------------------------------------- |
| Node.js                     | ≥ 22.13 (developed on 26.3) | `node:sqlite` is available without flags from 22.13                                          |
| `@modelcontextprotocol/sdk` | 1.32.x                      | Official TypeScript SDK; `McpServer` + `StdioServerTransport`; accepts Zod `^3.25 \|\| ^4`   |
| Zod                         | 4.x                         | Schema validation for config and tool inputs                                                 |
| SQLite                      | `node:sqlite` (built in)    | No native addon to compile on Windows. Fallback: `better-sqlite3` if Phase 2 finds a blocker |
| TypeScript                  | 6.0.x (pinned)              | typescript-eslint 8.73 supports `<6.1`; TypeScript 7 is not yet supported by the linter      |
| Vitest / ESLint / Prettier  | 5.1 / 10.15 / 3.10          | Current stable releases                                                                      |

## 5. Gaps UAB must fill independently

### 5.1 Human approval that the model cannot fake

UAB supports two approval channels, selected in configuration:

| Channel           | How the human approves                                                                                                                                                                                                | Guarantee                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `local` (default) | The human runs `uab approve <task-id>` in a terminal, or uses a future local console. The command shows the full prompt and its hash first. The MCP `approve_task` tool refuses and returns the exact command to run. | Strong: only someone with access to the local terminal can approve.              |
| `chat` (opt-in)   | ChatGPT calls `approve_task` with the task id **and the prompt hash shown to the user**. The README tells users to set `tools.approve_task.approval_mode = "approve"` so ChatGPT asks them every time.                | Weaker: UAB depends on the host's prompt and the user's config, and must say so. |

In both channels the approval record is bound to the session id, task id, agent id, the
canonical project path, the SHA-256 of the exact prompt, the prompt version and an expiry time.
Dispatch recomputes all of them and refuses on any mismatch. An approval is consumed once,
inside the same transaction that marks the task as dispatched.

### 5.2 Conversation-to-session binding

Since the server cannot identify the conversation:

1. `create_session` requires an explicit absolute project path and agent id. It returns a
   **session id** (`UAB-<random>`) and a **session token** (high-entropy random value; only its
   hash is stored).
2. Every session-scoped tool requires both the id and the token. A wrong or missing token
   returns the same `SESSION_NOT_FOUND` error as an unknown id, so ids cannot be probed.
3. ChatGPT keeps the id and token in its conversation context. A different conversation does
   not have the token, so it cannot reach this session by accident.
4. `list_sessions` over MCP returns metadata only (id, project name, agent, status), never
   tokens, prompts or results.
5. To continue a session in a **new** conversation, the user runs
   `uab session rotate-token <id>` locally and pastes the new token. Only a hash is stored, so
   the original token cannot be shown again; rotating also revokes the old conversation's
   access. This is an explicit, human-initiated transfer.

This prevents **accidental** cross-session access, which is the threat in the requirements. It
cannot prevent a user from pasting a token into another chat on purpose, and the docs will say
so.

### 5.3 Long-running execution under a 60-second tool timeout

`dispatch_task` starts the agent in the background and returns at once. ChatGPT polls with
`get_task_status` / `get_task_result`. If the MCP server process exits, running tasks are marked
`interrupted` at next startup and are **never re-run automatically** (at-most-once).

### 5.4 Other gaps

Agent detection and authentication probing, result collection (git status/diff, changed files,
test output parsing), secret redaction, output limits and paging, working-tree locking, audit
log. None of the reviewed projects provides these in a reusable, licence-compatible form for
this stack.

## 6. Why this architecture

- **Local stdio on the desktop app** is the only documented path that needs no network exposure.
- **Out-of-band approval by default** is the only design in which "a human approved this" holds
  even if the model misbehaves or a project file contains a prompt injection.
- **Thin adapters over native CLI flags** keep each agent's own authentication and permission
  system in charge, and adding a new CLI means adding one adapter directory.
- **SQLite with no native build** works on Windows without compilers and supports several MCP
  processes sharing one state file (WAL mode).
