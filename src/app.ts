import os from 'node:os';
import { BUILTIN_AGENTS } from './agents/adapters/builtin.js';
import { AgentRegistry, type AgentRegistryOptions } from './agents/registry.js';
import { loadConfig, type LoadConfigOptions, type LoadedConfig } from './core/config.js';
import type { RandomBytes } from './core/ids.js';
import { databaseFile, openDatabase, type Database } from './database/index.js';
import type { MigrationResult } from './database/migrate.js';
import { ProjectRegistry } from './projects/registry.js';
import { SessionAdmin } from './sessions/admin.js';
import { SessionManager } from './sessions/manager.js';
import type { Actor } from './sessions/types.js';

export interface AppOptions extends LoadConfigOptions {
  readonly now?: () => Date;
  readonly randomBytes?: RandomBytes;
  /** Test hook: replaces process spawning for agent probes. */
  readonly runProcess?: AgentRegistryOptions['run'];
}

export interface App {
  readonly loaded: LoadedConfig;
  readonly db: Database;
  readonly migration: MigrationResult;
  readonly projects: ProjectRegistry;
  readonly agents: AgentRegistry;
  readonly sessionAdmin: SessionAdmin;
  /** Session operations on behalf of `actor` (`mcp` for ChatGPT, `cli` for the operator). */
  sessions(actor: Actor): SessionManager;
  close(): void;
}

/** Loads configuration, opens and migrates the database and wires the services together. */
export async function openApp(options: AppOptions = {}): Promise<App> {
  const loaded = await loadConfig(options);
  // Created before the database so an invalid agents section fails without touching it.
  const agents = new AgentRegistry(BUILTIN_AGENTS, {
    overrides: loaded.config.agents,
    env: options.env ?? process.env,
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

  return {
    loaded,
    db,
    migration,
    projects,
    agents,
    sessionAdmin: new SessionAdmin(common),
    sessions: (actor) =>
      new SessionManager({
        ...common,
        projects,
        actor,
        isKnownAgent: (id) => agents.isAvailable(id),
        allowMcpRegistration: loaded.config.projects.allowMcpRegistration,
      }),
    close: () => {
      db.close();
    },
  };
}
