import {
  parseJsonObject,
  parseSemver,
  safeLabel,
  stripAnsi,
  type AgentDefinition,
  type AuthResult,
  type ProbeOutput,
} from '../types.js';

const NOT_LOGGED_IN =
  /not\s+(logged|signed)\s+in|no\s+active\s+(session|login)|please\s+(log|sign)\s+in/i;

export function parseKiroAuth(output: ProbeOutput): AuthResult {
  const json = output.exitCode === 0 ? parseJsonObject(output.stdout) : undefined;
  if (json !== undefined && json.accountType !== undefined) {
    const method = safeLabel(json.accountType);
    return { state: 'authenticated', ...(method === undefined ? {} : { method }) };
  }
  if (NOT_LOGGED_IN.test(`${output.stdout}\n${output.stderr}`)) {
    return { state: 'not_authenticated', detail: 'Kiro CLI reports that you are not logged in.' };
  }
  return { state: 'unknown', detail: 'Could not read the login status from `kiro-cli whoami`.' };
}

/**
 * Kiro CLI. Detection uses `kiro-cli --version` and `kiro-cli whoami -f json`.
 * Verified locally with Kiro CLI 2.27.1 on Windows 11.
 */
export const kiroDefinition: AgentDefinition = {
  id: 'kiro',
  displayName: 'Kiro CLI',
  executableNames: ['kiro-cli'],
  versionProbe: { args: ['--version'], parse: parseSemver },
  authProbe: { args: ['whoami', '-f', 'json'], parse: parseKiroAuth },
  envPassthrough: ['KIRO_API_KEY', 'KIRO_HOME'],
  forbiddenArgs: [
    { flag: '--trust-all-tools', reason: 'Approves every tool call without asking.' },
    { flag: '-a', reason: 'Short form of --trust-all-tools.' },
    {
      flag: '--trust-tools',
      values: ['', '*'],
      valuePattern: /(^|,)\s*(\*|@builtin)\s*(,|$)/,
      reason:
        'An empty or wildcard list trusts all tools (an empty list is affected by kirodotdev/Kiro#12037).',
    },
  ],
  capabilities: { resume: true, callerChosenSessionId: false, structuredEvents: true },
  instructions: {
    install: [
      'macOS / Linux: curl -fsSL https://cli.kiro.dev/install | bash',
      'Windows 11: see https://kiro.dev/docs/getting-started/installation/',
    ],
    authenticate: ['kiro-cli login'],
    docsUrl: 'https://kiro.dev/docs/getting-started/installation/',
  },
  notes: [
    'Kiro documents that headless (--no-interactive) runs authenticate with KIRO_API_KEY, which needs a Pro or higher plan. Whether an interactive login is enough is verified in Phase 4.',
  ],
};

export function parseClaudeAuth(output: ProbeOutput): AuthResult {
  const json = parseJsonObject(output.stdout);
  if (json === undefined || typeof json.loggedIn !== 'boolean') {
    return { state: 'unknown', detail: 'Could not read `claude auth status --json`.' };
  }
  if (!json.loggedIn) {
    return {
      state: 'not_authenticated',
      detail: 'Claude Code reports that you are not logged in.',
    };
  }
  const method = safeLabel(json.authMethod);
  return { state: 'authenticated', ...(method === undefined ? {} : { method }) };
}

/**
 * Claude Code. `claude auth status --json` returns `loggedIn`, `authMethod`, `apiProvider` and
 * `apiKeySource`; UAB reads only `loggedIn` and `authMethod`. The `--text` form prints the API
 * base URL, so it is never used. Verified locally with Claude Code 2.1.220.
 */
export const claudeDefinition: AgentDefinition = {
  id: 'claude',
  displayName: 'Claude Code',
  executableNames: ['claude'],
  versionProbe: { args: ['--version'], parse: parseSemver },
  authProbe: { args: ['auth', 'status', '--json'], parse: parseClaudeAuth },
  envPassthrough: [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'AWS_PROFILE',
    'AWS_REGION',
  ],
  forbiddenArgs: [
    { flag: '--dangerously-skip-permissions', reason: 'Bypasses all permission checks.' },
    {
      flag: '--allow-dangerously-skip-permissions',
      reason: 'Makes permission bypass available in the session.',
    },
    {
      flag: '--permission-mode',
      values: ['bypassPermissions'],
      reason: 'Bypasses all permission checks.',
    },
    {
      flag: '--settings',
      valuePattern: /bypassPermissions|dangerously/i,
      reason: 'Settings that bypass permission checks.',
    },
  ],
  capabilities: { resume: true, callerChosenSessionId: true, structuredEvents: true },
  instructions: {
    install: [
      'macOS / Linux / WSL: curl -fsSL https://claude.ai/install.sh | bash',
      'Windows PowerShell: irm https://claude.ai/install.ps1 | iex',
      'Windows (WinGet): winget install Anthropic.ClaudeCode',
    ],
    authenticate: ['claude auth login', 'or run `claude` once and follow the sign-in prompt'],
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
  },
};

export function parseOpenCodeAuth(output: ProbeOutput): AuthResult {
  if (output.exitCode !== 0) {
    return { state: 'unknown', detail: 'Could not run `opencode providers list`.' };
  }
  const match = /(\d+)\s+credentials?\b/i.exec(stripAnsi(output.stdout));
  if (match?.[1] === undefined) {
    return { state: 'unknown', detail: 'Could not read `opencode providers list`.' };
  }
  const count = Number(match[1]);
  if (count === 0) {
    return {
      state: 'not_authenticated',
      detail:
        'No stored provider credentials. Providers configured only through environment variables are not detected.',
    };
  }
  return {
    state: 'authenticated',
    method: 'stored_credentials',
    detail: `${String(count)} stored provider credential(s).`,
  };
}

/**
 * OpenCode. `opencode providers list` prints stored credentials as text; UAB reads only the
 * count. Verified locally with OpenCode 1.19.3 (V1, npm package `opencode-ai`). OpenCode V2
 * (`@opencode/cli`) changes permission configuration; adapters are re-verified in Phase 9.
 */
export const opencodeDefinition: AgentDefinition = {
  id: 'opencode',
  displayName: 'OpenCode',
  executableNames: ['opencode'],
  versionProbe: { args: ['--version'], parse: parseSemver },
  authProbe: { args: ['providers', 'list'], parse: parseOpenCodeAuth },
  envPassthrough: ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR'],
  forbiddenArgs: [
    { flag: '--auto', reason: 'Auto-approves permissions that are not explicitly denied.' },
  ],
  capabilities: { resume: true, callerChosenSessionId: false, structuredEvents: true },
  instructions: {
    install: [
      'macOS / Linux: curl -fsSL https://opencode.ai/v2/install | bash',
      'npm: npm install -g @opencode/cli',
      'Windows: download the standalone binary listed at https://opencode.ai/docs/',
    ],
    authenticate: ['opencode providers login', 'or use /connect inside the OpenCode TUI'],
    docsUrl: 'https://opencode.ai/docs/',
  },
  notes: [
    'Providers authenticated only through environment variables are reported as not authenticated.',
  ],
};

export function parseCodexAuth(output: ProbeOutput): AuthResult {
  const text = `${output.stdout}\n${output.stderr}`;
  if (output.exitCode === 0 && /logged in/i.test(text) && !/not logged in/i.test(text)) {
    const method = /chatgpt/i.test(text)
      ? 'chatgpt'
      : /api key/i.test(text)
        ? 'api_key'
        : undefined;
    return { state: 'authenticated', ...(method === undefined ? {} : { method }) };
  }
  if (NOT_LOGGED_IN.test(text)) {
    return { state: 'not_authenticated', detail: 'Codex CLI reports that you are not logged in.' };
  }
  return { state: 'unknown', detail: 'Could not read `codex login status`.' };
}

/**
 * Codex CLI. Not installed on the development machine: probes follow the documentation and
 * need manual verification (Phase 10).
 */
export const codexDefinition: AgentDefinition = {
  id: 'codex',
  displayName: 'Codex CLI',
  executableNames: ['codex'],
  versionProbe: { args: ['--version'], parse: parseSemver },
  authProbe: { args: ['login', 'status'], parse: parseCodexAuth },
  envPassthrough: ['CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY'],
  forbiddenArgs: [
    {
      flag: '--sandbox',
      values: ['danger-full-access'],
      reason: 'Removes the sandbox.',
    },
    { flag: '-s', values: ['danger-full-access'], reason: 'Removes the sandbox.' },
    { flag: '--yolo', reason: 'Disables approvals and the sandbox.' },
    {
      flag: '--dangerously-bypass-approvals-and-sandbox',
      reason: 'Disables approvals and the sandbox.',
    },
    {
      flag: '-c',
      valuePattern: /danger-full-access/i,
      reason: 'Config override that removes the sandbox.',
    },
    {
      flag: '--config',
      valuePattern: /danger-full-access/i,
      reason: 'Config override that removes the sandbox.',
    },
  ],
  capabilities: { resume: true, callerChosenSessionId: false, structuredEvents: true },
  instructions: {
    install: [
      'macOS / Linux: curl -fsSL https://chatgpt.com/codex/install.sh | sh',
      'Windows PowerShell: powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
      'npm: npm install -g @openai/codex',
    ],
    authenticate: ['codex login'],
    docsUrl: 'https://learn.chatgpt.com/docs/codex/cli',
  },
  notes: [
    'Detection follows the Codex documentation and has not been verified against a real installation yet.',
  ],
};

export const BUILTIN_AGENTS: readonly AgentDefinition[] = [
  kiroDefinition,
  claudeDefinition,
  opencodeDefinition,
  codexDefinition,
];
