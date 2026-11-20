import { randomBytes } from 'node:crypto';
import { Database, MEMORY, MIGRATIONS, migrate } from '../../src/database/index.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { SessionAdmin } from '../../src/sessions/admin.js';
import { SessionManager } from '../../src/sessions/manager.js';
import type { Actor } from '../../src/sessions/types.js';
import { createSandbox, type Sandbox } from './fs.js';

/** A manually advanced clock, so ordering and timestamps are deterministic. */
export function fakeClock(start = '2026-01-01T00:00:00.000Z'): {
  now: () => Date;
  advance: (ms: number) => void;
} {
  let t = Date.parse(start);
  return {
    now: () => new Date(t),
    advance: (ms) => {
      t += ms;
    },
  };
}

export interface Services {
  readonly sandbox: Sandbox;
  readonly db: Database;
  readonly projects: ProjectRegistry;
  readonly admin: SessionAdmin;
  readonly clock: ReturnType<typeof fakeClock>;
  sessions(actor?: Actor, options?: { allowMcpRegistration?: boolean }): SessionManager;
  close(): void;
}

/** In-memory database plus real filesystem sandbox for project directories. */
export function createServices(): Services {
  const sandbox = createSandbox();
  const db = Database.open(MEMORY);
  migrate(db, MIGRATIONS);
  const clock = fakeClock();
  const projects = new ProjectRegistry({
    db,
    now: clock.now,
    policy: { homedir: sandbox.home, dataDir: sandbox.dataDir },
  });
  return {
    sandbox,
    db,
    projects,
    clock,
    admin: new SessionAdmin({ db, now: clock.now }),
    sessions: (actor = 'mcp', options = {}) =>
      new SessionManager({
        db,
        projects,
        actor,
        now: clock.now,
        randomBytes,
        ...(options.allowMcpRegistration === undefined
          ? {}
          : { allowMcpRegistration: options.allowMcpRegistration }),
      }),
    close: () => {
      db.close();
      sandbox.cleanup();
    },
  };
}
