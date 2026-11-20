import type { RandomBytes } from '../core/ids.js';
import type { Database } from '../database/index.js';
import type { SessionContext } from '../tasks/service.js';
import { SessionStore, sessionNotFound } from './store.js';
import {
  SESSION_ID_PATTERN,
  hashSessionToken,
  newSessionToken,
  type SessionDetails,
  type SessionEventPage,
} from './types.js';

export interface SessionAdminDeps {
  readonly db: Database;
  readonly now?: () => Date;
  readonly randomBytes?: RandomBytes;
}

/**
 * Operator-only session operations for the local `uab` CLI. Not exposed over MCP: whoever
 * can run this already has full access to the local database.
 */
export class SessionAdmin {
  readonly #store: SessionStore;
  readonly #random: RandomBytes | undefined;

  constructor(deps: SessionAdminDeps) {
    this.#store = new SessionStore(deps.db, deps.now ?? (() => new Date()), deps.randomBytes);
    this.#random = deps.randomBytes;
  }

  #id(sessionId: string): string {
    const id = sessionId.trim().toUpperCase();
    if (!SESSION_ID_PATTERN.test(id)) throw sessionNotFound();
    this.#store.requireRow(id);
    return id;
  }

  list(options: { includeClosed?: boolean } = {}): SessionDetails[] {
    return this.#store
      .summaries(options.includeClosed === true)
      .map((s) => this.#store.details(s.sessionId));
  }

  get(sessionId: string): SessionDetails {
    return this.#store.details(this.#id(sessionId));
  }

  /** Session context for operator actions on a session's tasks (local user only). */
  context(sessionId: string): SessionContext {
    const row = this.#store.requireRow(this.#id(sessionId));
    return {
      sessionId: row.id,
      projectId: row.project_id,
      agentId: row.agent_id,
      status: row.status,
    };
  }

  history(sessionId: string, query?: unknown): SessionEventPage {
    return this.#store.events(this.#id(sessionId), query);
  }

  close(sessionId: string): SessionDetails {
    const id = this.#id(sessionId);
    this.#store.db.transaction(() => {
      if (this.#store.closeSession(id)) this.#store.addEvent(id, 'cli', 'closed');
    });
    return this.#store.details(id);
  }

  /**
   * Issues a new token and invalidates the old one. This is how a user continues a session in a
   * new ChatGPT conversation, or revokes access from a conversation that should no longer have it.
   */
  rotateToken(sessionId: string): { session: SessionDetails; sessionToken: string } {
    const id = this.#id(sessionId);
    const sessionToken = newSessionToken(this.#random);
    this.#store.db.transaction(() => {
      this.#store.setTokenHash(id, hashSessionToken(sessionToken));
      this.#store.addEvent(id, 'cli', 'token_rotated');
    });
    return { session: this.#store.details(id), sessionToken };
  }
}
