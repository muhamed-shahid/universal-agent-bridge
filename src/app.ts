import os from 'node:os';
import { BUILTIN_AGENTS } from './agents/adapters/builtin.js';
import { AgentRegistry, type AgentRegistryOptions } from './agents/registry.js';
import type { AgentDefinition } from './agents/types.js';
import { loadConfig, type LoadConfigOptions, type LoadedConfig } from './core/config.js';
import type { RandomBytes } from './core/ids.js';
import { createLogger, type Logger } from './core/logger.js';
import { databaseFile, openDatabase, type Database } from './database/index.js';
import type { MigrationResult } from './database/migrate.js';
import { ExecutionManager } from './execution/manager.js';
import type { RunRequest, RunResult } from './execution/process.js';
import { ProjectRegistry } from './projects/registry.js';
import { Git } from './results/git.js';
import { Redactor } from './security/redact.js';
import { SessionAdmin } from './sessions/admin.js';
import { SessionManager } from './sessions/manager.js';
import type { Actor } from './sessions/types.js';
import { TaskService } from './tasks/service.js';

export interface AppOptions extends LoadConfigOptions {
  readonly now?: () => Date;
  readonly randomBytes?: RandomBytes;
  /** Test hook: replaces process spawning for agent probes and runs. */
  readonly runProcess?: AgentRegistryOptions['run'] & ((req: RunRequest) => Promise<RunResult>);
  /** Test hook: replaces the built-in agent definitions. */
  readonly agentDefinitions?: readonly AgentDefinition[];
  readonly logger?: Logger;
  /** Test hook: heartbeat interval of running tasks. */
  readonly heartbeatMs?: number;
}

export interface App {
  readonly loaded: LoadedConfig;
  readonly db: Database;
  readonly migration: MigrationResult;
  readonly projects: ProjectRegistry;
  readonly agents: AgentRegistry;
  readonly tasks: TaskService;
  readonly executions: ExecutionManager;
  readonly git: Git;
  readonly redactor: Redactor;
  readonly logger: Logger;
  readonly sessionAdmin: SessionAdmin;
  /** Session operations on behalf of `actor` (`mcp` for ChatGPT, `cli` for the operator). */
  sessions(actor: Actor): SessionManager;
  close(): void;
}

/** Loads configuration, opens and migrates the database and wires the services together. */
export async function openApp(options: AppOptions = {}): Promise<App> {
  const loaded = await loadConfig(options);
  const env = options.env ?? process.env;
  const config = loaded.config;
  const logger = options.logger ?? createLogger({ level: config.logLevel });
  // Created before the database so an invalid agents section fails without touching it.
  const agents = new AgentRegistry(options.agentDefinitions ?? BUILTIN_AGENTS, {
    overrides: config.agents,
    env,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.runProcess === undefined ? {} : { run: options.runProcess }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const homedir = options.homedir ?? os.homedir();
  const { db, migration } = openDatabase(databaseFile(loaded.dataDir), {
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const common = {
    db,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
  };
  const projects = new ProjectRegistry({
    ...common,
    policy: {
      homedir,
      dataDir: loaded.dataDir,
      ...(options.platform === undefined ? {} : { platform: options.platform }),
    },
  });
  const tasks = new TaskService({
    ...common,
    approvalExpiryMinutes: config.approval.expiryMinutes,
    approvalChannel: config.approval.channel,
  });
  const redactor = new Redactor(env);
  const git = new Git(env);
  const executions = new ExecutionManager({
    ...common,
    tasks,
    agents,
    redactor,
    git,
    env,
    logger,
    timeoutMs: config.execution.timeoutMinutes * 60_000,
    verifyTimeoutMs: config.execution.verifyTimeoutMinutes * 60_000,
    maxOutputBytes: config.execution.maxOutputBytes,
    ...(options.runProcess === undefined ? {} : { run: options.runProcess }),
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
  });

  return {
    loaded,
    db,
    migration,
    projects,
    agents,
    tasks,
    executions,
    git,
    redactor,
    logger,
    sessionAdmin: new SessionAdmin(common),
    sessions: (actor) =>
      new SessionManager({
        ...common,
        projects,
        actor,
        isKnownAgent: (id) => agents.isAvailable(id),
        allowMcpRegistration: config.projects.allowMcpRegistration,
      }),
    close: () => {
      db.close();
    },
  };
}
