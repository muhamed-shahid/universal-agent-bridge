import os from 'node:os';
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
}

export interface App {
  readonly loaded: LoadedConfig;
  readonly db: Database;
  readonly migration: MigrationResult;
  readonly projects: ProjectRegistry;
  readonly sessionAdmin: SessionAdmin;
  /** Session operations on behalf of `actor` (`mcp` for ChatGPT, `cli` for the operator). */
  sessions(actor: Actor): SessionManager;
  close(): void;
}

/** Loads configuration, opens and migrates the database and wires the services together. */
export async function openApp(options: AppOptions = {}): Promise<App> {
  const loaded = await loadConfig(options);
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
    sessionAdmin: new SessionAdmin(common),
    sessions: (actor) =>
      new SessionManager({
        ...common,
        projects,
        actor,
        allowMcpRegistration: loaded.config.projects.allowMcpRegistration,
      }),
    close: () => {
      db.close();
    },
  };
}
