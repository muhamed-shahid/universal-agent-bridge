/**
 * The contract every coding-CLI adapter implements.
 *
 * Phase 3 covers detection: finding the program, reading its version and checking its native
 * login. Execution hooks (build an invocation, parse output events, resume a native session)
 * are added per agent in Phases 4 and 8â€“10 through `execution`. Process spawning, timeouts and
 * output limits belong to the execution layer, not to adapters, so they are implemented once.
 *
 * Conceptual interface from the requirements â†’ where it lives:
 *   detectInstallation / getVersion  â†’ `executableNames` + `versionProbe` (run by the registry)
 *   checkAuthentication              â†’ `authProbe` (run by the registry)
 *   startSession / resumeSession / executeTask / collectOutput â†’ `execution` (Phase 4+)
 *   getExecutionStatus / terminateExecution / cleanupSession   â†’ execution and session managers
 */

/** Output of a finished probe command, passed to the adapter's pure parser. */
export interface ProbeOutput {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProbeSpec<T> {
  /** Constant arguments. Probes must never start a model conversation or change state. */
  readonly args: readonly string[];
  /**
   * Converts output to a result. Must be pure and must return only allowlisted, non-secret
   * fields: never raw output, emails, tokens, keys, URLs or account ids.
   */
  readonly parse: (output: ProbeOutput) => T;
}

export type AuthState = 'authenticated' | 'not_authenticated' | 'unknown';

export interface AuthResult {
  readonly state: AuthState;
  /** Short, non-secret label such as `api_key`, `chatgpt` or `IamIdentityCenter`. */
  readonly method?: string;
  /** Short explanation shown to the user. Never contains CLI output. */
  readonly detail?: string;
}

/**
 * An argument the bridge must never pass to this CLI because it weakens the CLI's own
 * permission checks. Without `values`, the flag is forbidden in every form. With `values`, the
 * flag is forbidden only with one of those values (`--flag value` or `--flag=value`).
 * Use `''` in `values` to forbid an empty value.
 */
export interface ForbiddenArg {
  readonly flag: string;
  readonly values?: readonly string[];
  /** Forbidden when the flag's value matches (for generic config overrides such as `-c`). */
  readonly valuePattern?: RegExp;
  readonly reason: string;
}

export interface AgentInstructions {
  /** One or more ways to install, shown as-is to the user. */
  readonly install: readonly string[];
  /** How to log in with the CLI's own mechanism. UAB never handles credentials. */
  readonly authenticate: readonly string[];
  readonly docsUrl: string;
}

export interface AgentCapabilities {
  /** Can continue a native conversation in a later task. */
  readonly resume: boolean;
  /** UAB can choose the native session id up front (for example Claude `--session-id`). */
  readonly callerChosenSessionId: boolean;
  /** The CLI emits machine-readable events while running. */
  readonly structuredEvents: boolean;
}

export interface AgentDefinition {
  /** Stable public id, lowercase (`kiro`, `claude`, â€¦). */
  readonly id: string;
  readonly displayName: string;
  /** Program names to look for on PATH, in order (no extension). */
  readonly executableNames: readonly string[];
  readonly versionProbe: ProbeSpec<string | undefined>;
  readonly authProbe: ProbeSpec<AuthResult>;
  /**
   * Extra environment variable names the CLI needs for its own login or configuration. They
   * are passed through to the CLI unchanged. UAB reports only whether each is set; it never
   * reads, logs or stores the values.
   */
  readonly envPassthrough: readonly string[];
  readonly forbiddenArgs: readonly ForbiddenArg[];
  readonly capabilities: AgentCapabilities;
  readonly instructions: AgentInstructions;
  /** Free-text notes about known limitations, shown in status output. */
  readonly notes?: readonly string[];
  /** Present once the agent can run tasks. */
  readonly execution?: AgentExecution;
}

/** How a task may affect the project. Derived from the task kind, never from the prompt. */
export type TaskMode = 'read_only' | 'workspace_write';

/** User settings for an agent, from the UAB config (`agents.<id>`). */
export interface AgentSettings {
  /** Native agent/profile name (Kiro `--agent`, OpenCode `--agent`). */
  readonly profile?: string | undefined;
  readonly model?: string | undefined;
  /** Native, scoped permission rules to pre-approve for write tasks (Claude `--allowedTools`). */
  readonly allowTools?: readonly string[] | undefined;
}

export interface InvocationRequest {
  /** The exact text the user approved. Sent on stdin. */
  readonly prompt: string;
  /** Canonical project directory. The process runs here. */
  readonly cwd: string;
  readonly mode: TaskMode;
  /** Native conversation to continue, or null to start a new one. */
  readonly nativeSessionId: string | null;
  /** A fresh UUID the adapter may use when the CLI lets the caller choose the session id. */
  readonly newSessionId: string;
  readonly settings: AgentSettings;
}

export interface Invocation {
  readonly args: readonly string[];
  readonly stdin: string;
  /** Set when the session id is known before the run (caller-chosen). */
  readonly nativeSessionId?: string;
}

export type AgentEvent =
  | { readonly type: 'session'; readonly nativeSessionId: string }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'final'; readonly text: string; readonly success: boolean | null }
  | {
      readonly type: 'tool';
      readonly name: string;
      readonly status: string;
      readonly path?: string;
    }
  | { readonly type: 'permission_denied'; readonly tool: string }
  | { readonly type: 'error'; readonly message: string; readonly fatal?: boolean };

/** Execution hooks. Pure functions: the execution manager spawns and supervises the process. */
export interface AgentExecution {
  readonly supported: true;
  /** False when the integration was built from documentation and not run against the real CLI. */
  readonly verified: boolean;
  buildInvocation(req: InvocationRequest): Invocation;
  parseStdoutLine(line: string): AgentEvent[];
  parseStderrLine?(line: string): AgentEvent[];
  /** Shown when the run fails in a way that usually means setup is missing. */
  readonly setupHint?: string;
}

export function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Shared version parser: first `x.y.z` (with optional pre-release) in stdout. */
export function parseSemver(output: ProbeOutput): string | undefined {
  if (output.exitCode !== 0) return undefined;
  return /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(output.stdout)?.[1];
}

/** Accepts a short label made of safe characters; anything else is dropped. */
export function safeLabel(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(value)
    ? value
    : undefined;
}

export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Removes ANSI escape sequences (colours, cursor movement). */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- matching escape sequences is the purpose.
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, '');
}
