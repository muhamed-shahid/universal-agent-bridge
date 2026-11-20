import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { z } from 'zod';
import { ErrorCode, UabError } from './errors.js';
import { resolveConfigPath, resolveDataDir, type PathEnvironment } from './paths.js';
import { formatIssues } from './validation.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * User configuration file schema. Objects are strict so a misspelt key fails loudly instead
 * of silently falling back to a default (for example, a typo in a security setting).
 */
export const configSchema = z.strictObject({
  logLevel: z.enum(LOG_LEVELS).default('info'),
  approval: z
    .strictObject({
      /**
       * `local`: only a human at the terminal can approve (`uab approve`). Default.
       * `chat`: ChatGPT may call approve_task with the prompt hash. Weaker; opt-in.
       */
      channel: z.enum(['local', 'chat']).default('local'),
      /** Minutes an approval stays valid before dispatch. Never auto-approves. */
      expiryMinutes: z.int().min(1).max(1440).default(60),
    })
    .prefault({}),
  execution: z
    .strictObject({
      /** Hard limit for one agent run, in minutes. */
      timeoutMinutes: z.int().min(1).max(240).default(30),
      /** Limit for the project's verification command (`uab project set-test`), in minutes. */
      verifyTimeoutMinutes: z.int().min(1).max(120).default(10),
      /** Maximum agent output stored per execution, in bytes. */
      maxOutputBytes: z
        .int()
        .min(64 * 1024)
        .max(64 * 1024 * 1024)
        .default(2 * 1024 * 1024),
    })
    .prefault({}),
  mcp: z
    .strictObject({
      /** Maximum size of a single MCP tool response body, in bytes. */
      maxResponseBytes: z
        .int()
        .min(4 * 1024)
        .max(1024 * 1024)
        .default(64 * 1024),
    })
    .prefault({}),
  projects: z
    .strictObject({
      /**
       * Whether ChatGPT may register a new project directory through create_session.
       * Default false: the user registers directories with `uab project add`, so a
       * conversation can never point UAB at an arbitrary local folder.
       */
      allowMcpRegistration: z.boolean().default(false),
    })
    .prefault({}),
  /**
   * Per-agent settings, keyed by agent id. Example:
   * `{ "agents": { "codex": { "enabled": false }, "claude": { "executable": "C:\\Tools\\claude.exe" } } }`
   * Unknown agent ids are rejected when the agent registry is created.
   */
  agents: z
    .record(
      z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, 'must be a lowercase agent id'),
      z.strictObject({
        enabled: z.boolean().optional(),
        /** Absolute path of the CLI program. Skips the PATH search. */
        executable: z.string().min(1).max(4096).optional(),
        /** Native agent/profile name (Kiro and OpenCode `--agent`). */
        profile: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, 'must be a simple profile name')
          .optional(),
        /** Model name passed with `--model`. */
        model: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/@[\]-]{0,127}$/, 'must be a simple model name')
          .optional(),
        /**
         * Native allow rules for write tasks (Claude Code `--allowedTools`), for example
         * `Bash(npm test:*)`. Only for agents whose CLI supports scoped rules.
         */
        allowTools: z
          .array(
            z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_*():.,/ @=-]{0,199}$/, 'must be a tool rule'),
          )
          .max(50)
          .optional(),
      }),
    )
    .default({}),
});

export type UabConfig = z.infer<typeof configSchema>;

export interface LoadedConfig {
  readonly config: UabConfig;
  readonly dataDir: string;
  readonly configPath: string;
  /** False when no config file exists and defaults were used. */
  readonly fromFile: boolean;
}

export interface LoadConfigOptions extends Partial<PathEnvironment> {
  readonly readTextFile?: (filePath: string) => Promise<string>;
}

/** Validates an already-parsed config object. Environment overrides are applied first. */
export function parseConfig(
  raw: unknown,
  env: Readonly<Record<string, string | undefined>> = {},
): UabConfig {
  let base: Record<string, unknown>;
  if (raw === undefined) {
    base = {};
  } else if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    base = { ...(raw as Record<string, unknown>) };
  } else {
    throw new UabError(ErrorCode.CONFIG_INVALID, 'Configuration must be a JSON object.');
  }

  const envLevel = env.UAB_LOG_LEVEL?.trim();
  if (envLevel !== undefined && envLevel !== '') {
    base.logLevel = envLevel;
  }

  const result = configSchema.safeParse(base);
  if (!result.success) {
    throw new UabError(ErrorCode.CONFIG_INVALID, 'Configuration is invalid.', {
      details: { issues: formatIssues(result.error) },
    });
  }
  return result.data;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Resolves paths, reads the optional config file and validates it. */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const pathEnv: PathEnvironment = {
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    homedir: options.homedir ?? os.homedir(),
  };
  const readTextFile = options.readTextFile ?? ((p: string) => readFile(p, 'utf8'));

  const dataDir = resolveDataDir(pathEnv);
  const configPath = resolveConfigPath(dataDir, pathEnv);

  let text: string | undefined;
  try {
    text = await readTextFile(configPath);
  } catch (error) {
    if (!isNotFound(error)) {
      throw new UabError(ErrorCode.CONFIG_NOT_READABLE, 'Configuration file cannot be read.', {
        details: { configPath },
        cause: error,
      });
    }
  }

  let raw: unknown;
  if (text !== undefined) {
    try {
      raw = JSON.parse(text) as unknown;
    } catch (error) {
      throw new UabError(ErrorCode.CONFIG_INVALID, 'Configuration file is not valid JSON.', {
        details: { configPath },
        cause: error,
      });
    }
  }

  return {
    config: parseConfig(raw, pathEnv.env),
    dataDir,
    configPath,
    fromFile: text !== undefined,
  };
}
