import os from 'node:os';
import { ErrorCode, UabError } from '../core/errors.js';
import { buildChildEnv, isValidEnvName } from '../execution/env.js';
import { runProcess, type RunRequest, type RunResult } from '../execution/process.js';
import { findForbiddenArg } from './args.js';
import { AGENT_ID_PATTERN } from './ids.js';
import { resolveExecutable, type ResolvedExecutable, type ResolveResult } from './resolve.js';
import type {
  AgentCapabilities,
  AgentDefinition,
  AgentInstructions,
  AgentSettings,
  AuthResult,
  ProbeOutput,
  ProbeSpec,
} from './types.js';

export interface AgentOverride {
  readonly enabled?: boolean | undefined;
  /** Absolute path of the CLI; skips the PATH search. */
  readonly executable?: string | undefined;
  readonly profile?: string | undefined;
  readonly model?: string | undefined;
  readonly allowTools?: readonly string[] | undefined;
}

export interface AgentRegistryOptions {
  readonly overrides?: Readonly<Record<string, AgentOverride>>;
  /** Environment used to find programs and passed (filtered) to probes. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly probeTimeoutMs?: number;
  /** Working directory for probes. Probes never run inside a project. */
  readonly probeCwd?: string;
  /** Injected for tests. */
  readonly run?: (req: RunRequest) => Promise<RunResult>;
  readonly now?: () => Date;
}

export type AgentState =
  'ready' | 'not_installed' | 'not_authenticated' | 'auth_unknown' | 'disabled' | 'error';

export interface AgentInfo {
  readonly agentId: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly capabilities: AgentCapabilities;
  /** False until the agent's execution adapter exists (Phase 4 onwards). */
  readonly executionSupported: boolean;
  readonly instructions: AgentInstructions;
  readonly notes: readonly string[];
}

export interface AgentStatus extends AgentInfo {
  readonly state: AgentState;
  readonly installed: boolean;
  readonly executable: { readonly path: string; readonly source: 'path' | 'config' } | null;
  readonly version: string | null;
  readonly auth: AuthResult;
  /** Names of passthrough environment variables that are set. Values are never read. */
  readonly envSet: readonly string[];
  /** Problems found during detection, written for the user. Never contain CLI output. */
  readonly problems: readonly string[];
  readonly checkedAt: string;
}

const PROBE_OUTPUT_LIMIT = 64 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

function assertValidDefinition(def: AgentDefinition): void {
  const fail = (reason: string) =>
    new UabError(ErrorCode.AGENT_DEFINITION_INVALID, 'Invalid agent definition.', {
      details: { agentId: def.id, reason },
    });
  if (!AGENT_ID_PATTERN.test(def.id)) throw fail('id');
  if (def.executableNames.length === 0) throw fail('executableNames');
  for (const name of def.executableNames) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw fail('executableNames');
  }
  for (const name of def.envPassthrough) {
    if (!isValidEnvName(name)) throw fail('envPassthrough');
  }
  for (const probe of [def.versionProbe, def.authProbe] as ProbeSpec<unknown>[]) {
    if (findForbiddenArg(probe.args, def.forbiddenArgs) !== undefined) throw fail('probe_args');
  }
}

function resolveProblem(result: Exclude<ResolveResult, { ok: true }>): string {
  switch (result.reason) {
    case 'not_found':
      return 'Not found on PATH.';
    case 'not_executable':
      return 'The configured or found file is not an executable program.';
    case 'unsupported_wrapper':
      return 'Found a wrapper script UAB cannot run without a shell. Set agents.<id>.executable to the real program.';
    case 'invalid_override':
      return 'agents.<id>.executable must be an absolute path.';
  }
}

/**
 * Holds the agent definitions UAB knows about and reports their installation and login
 * status. Adding an agent means adding a definition; nothing else in the core changes.
 */
export class AgentRegistry {
  readonly #defs = new Map<string, AgentDefinition>();
  readonly #overrides: Readonly<Record<string, AgentOverride>>;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #platform: NodeJS.Platform;
  readonly #timeoutMs: number;
  readonly #cwd: string;
  readonly #run: (req: RunRequest) => Promise<RunResult>;
  readonly #now: () => Date;

  constructor(definitions: readonly AgentDefinition[], options: AgentRegistryOptions = {}) {
    for (const def of definitions) {
      assertValidDefinition(def);
      if (this.#defs.has(def.id)) {
        throw new UabError(ErrorCode.AGENT_DEFINITION_INVALID, 'Duplicate agent id.', {
          details: { agentId: def.id, reason: 'duplicate' },
        });
      }
      this.#defs.set(def.id, def);
    }
    this.#overrides = options.overrides ?? {};
    for (const id of Object.keys(this.#overrides)) {
      if (!this.#defs.has(id)) {
        throw new UabError(ErrorCode.CONFIG_INVALID, 'Configuration names an unknown agent.', {
          details: { issues: [`agents.${id}: unknown agent id`] },
        });
      }
    }
    this.#env = options.env ?? process.env;
    this.#platform = options.platform ?? process.platform;
    this.#timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.#cwd = options.probeCwd ?? os.tmpdir();
    this.#run = options.run ?? runProcess;
    this.#now = options.now ?? (() => new Date());
  }

  /** Ids of all agents, enabled or not. */
  ids(): string[] {
    return [...this.#defs.keys()];
  }

  /** True when the agent exists and is enabled; used to validate session agent ids. */
  isAvailable(agentId: string): boolean {
    return this.#defs.has(agentId) && this.#enabled(agentId);
  }

  definition(agentId: string): AgentDefinition {
    const def = this.#defs.get(agentId);
    if (def === undefined) {
      throw new UabError(ErrorCode.AGENT_NOT_FOUND, 'Unknown agent.', { details: { agentId } });
    }
    return def;
  }

  #enabled(agentId: string): boolean {
    return this.#overrides[agentId]?.enabled !== false;
  }

  info(agentId: string): AgentInfo {
    const def = this.definition(agentId);
    return {
      agentId: def.id,
      displayName: def.displayName,
      enabled: this.#enabled(def.id),
      capabilities: def.capabilities,
      executionSupported: def.execution?.supported === true,
      instructions: def.instructions,
      notes: def.notes ?? [],
    };
  }

  list(): AgentInfo[] {
    return this.ids().map((id) => this.info(id));
  }

  /** User settings for task execution (profile, model, extra allow rules). */
  settings(agentId: string): AgentSettings {
    const o = this.#overrides[agentId] ?? {};
    return { profile: o.profile, model: o.model, allowTools: o.allowTools };
  }

  /** The program to run for tasks. Throws when the agent is disabled or not installed. */
  resolveProgram(agentId: string): ResolvedExecutable {
    const def = this.definition(agentId);
    if (!this.#enabled(agentId)) {
      throw new UabError(ErrorCode.AGENT_NOT_FOUND, 'Unknown or disabled agent.', {
        details: { agentId },
      });
    }
    const override = this.#overrides[agentId]?.executable;
    const resolved = resolveExecutable(def.executableNames, {
      env: this.#env,
      platform: this.#platform,
      ...(override === undefined ? {} : { override }),
    });
    if (!resolved.ok) {
      throw new UabError(
        ErrorCode.AGENT_NOT_INSTALLED,
        `${def.displayName} is not installed or cannot be run.`,
        {
          details: {
            agentId,
            problem: resolveProblem(resolved).replace('<id>', agentId),
            install: def.instructions.install,
          },
        },
      );
    }
    return resolved.executable;
  }

  /** Environment for the agent's processes (allowlist plus its passthrough names). */
  childEnv(agentId: string): Record<string, string> {
    return buildChildEnv(this.#env, this.definition(agentId).envPassthrough, this.#platform);
  }

  async #probe<T>(
    command: string,
    prefixArgs: readonly string[],
    spec: ProbeSpec<T>,
    env: Record<string, string>,
  ): Promise<{ value: T } | { problem: string }> {
    const result = await this.#run({
      command,
      args: [...prefixArgs, ...spec.args],
      cwd: this.#cwd,
      env,
      timeoutMs: this.#timeoutMs,
      maxOutputBytes: PROBE_OUTPUT_LIMIT,
    });
    if (result.outcome === 'spawn_failed') {
      return {
        problem: `The program could not be started (${result.spawnError ?? 'unknown error'}).`,
      };
    }
    if (result.outcome === 'timed_out') {
      return {
        problem: `\`${spec.args.join(' ')}\` did not finish within ${String(this.#timeoutMs / 1000)} s.`,
      };
    }
    const output: ProbeOutput = {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    try {
      return { value: spec.parse(output) };
    } catch {
      return { problem: `Unexpected output from \`${spec.args.join(' ')}\`.` };
    }
  }

  /**
   * Detects one agent: finds the program, reads its version and checks its native login.
   * Runs only the definition's constant probe commands, outside any project directory.
   */
  async status(agentId: string): Promise<AgentStatus> {
    const def = this.definition(agentId);
    const info = this.info(agentId);
    const envSet = def.envPassthrough.filter((name) => {
      const value = this.#env[name];
      return value !== undefined && value !== '';
    });
    const base = { ...info, envSet, checkedAt: this.#now().toISOString() };
    const unknownAuth: AuthResult = { state: 'unknown' };

    if (!info.enabled) {
      return {
        ...base,
        state: 'disabled',
        installed: false,
        executable: null,
        version: null,
        auth: unknownAuth,
        problems: ['Disabled in the UAB configuration.'],
      };
    }

    const override = this.#overrides[agentId]?.executable;
    const resolved = resolveExecutable(def.executableNames, {
      env: this.#env,
      platform: this.#platform,
      ...(override === undefined ? {} : { override }),
    });
    if (!resolved.ok) {
      const problem = resolveProblem(resolved).replace('<id>', agentId);
      return {
        ...base,
        state: resolved.reason === 'not_found' ? 'not_installed' : 'error',
        installed: false,
        executable: null,
        version: null,
        auth: unknownAuth,
        problems: [problem],
      };
    }

    const { command, prefixArgs, source } = resolved.executable;
    const env = buildChildEnv(this.#env, def.envPassthrough, this.#platform);
    const problems: string[] = [];

    const version = await this.#probe(command, prefixArgs, def.versionProbe, env);
    if ('problem' in version) problems.push(version.problem);

    const authProbe = await this.#probe(command, prefixArgs, def.authProbe, env);
    let auth: AuthResult = unknownAuth;
    if ('problem' in authProbe) problems.push(authProbe.problem);
    else auth = authProbe.value;

    const versionValue = 'value' in version ? (version.value ?? null) : null;
    if ('value' in version && version.value === undefined) {
      problems.push('Could not read the version.');
    }

    const state: AgentState =
      auth.state === 'authenticated'
        ? 'ready'
        : auth.state === 'not_authenticated'
          ? 'not_authenticated'
          : 'auth_unknown';

    return {
      ...base,
      state,
      installed: true,
      executable: { path: command, source },
      version: versionValue,
      auth,
      problems,
    };
  }

  /** Detects all agents in parallel. */
  async statusAll(): Promise<AgentStatus[]> {
    return Promise.all(this.ids().map((id) => this.status(id)));
  }
}
