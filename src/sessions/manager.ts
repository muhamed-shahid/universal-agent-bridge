import { z } from 'zod';
import { BUILTIN_AGENTS } from '../agents/adapters/builtin.js';
import { AGENT_ID_PATTERN } from '../agents/ids.js';
import { ErrorCode, UabError } from '../core/errors.js';
import type { RandomBytes } from '../core/ids.js';
import { parseInput } from '../core/validation.js';
import type { Database } from '../database/index.js';
import type { Project, ProjectRegistry } from '../projects/registry.js';
import { SessionStore, sessionNotFound, type SessionRow } from './store.js';
import {
  hashSessionToken,
  newSessionToken,
  sessionRefSchema,
  sessionTitleSchema,
  tokenMatches,
  type Actor,
  type SessionDetails,
  type SessionEventPage,
  type SessionSummary,
} from './types.js';

export const agentIdSchema = z.string().regex(AGENT_ID_PATTERN, 'must be a lowercase agent id');

export const createSessionSchema = z.strictObject({
  /** Absolute project directory path, or a registered project id (PRJ-…). */
  project: z.string().min(1).max(4096),
  agentId: agentIdSchema,
  title: sessionTitleSchema.optional(),
});
export type CreateSessionInput = z.input<typeof createSessionSchema>;

export interface CreatedSession {
  readonly session: SessionDetails;
  /** Shown once. Only its SHA-256 hash is stored. */
  readonly sessionToken: string;
  readonly warnings: readonly string[];
}

export interface SessionManagerDeps {
  readonly db: Database;
  readonly projects: ProjectRegistry;
  /** Who is calling: `mcp` for ChatGPT tool calls, `cli` for the local operator. */
  readonly actor: Actor;
  /** Whether an MCP caller may register a new project directory. Default false. */
  readonly allowMcpRegistration?: boolean;
  /** Whether an agent id exists and is enabled. Default: the built-in agents. */
  readonly isKnownAgent?: (agentId: string) => boolean;
  readonly now?: () => Date;
  readonly randomBytes?: RandomBytes;
}

function concurrencyWarnings(others: number): string[] {
  if (others === 0) return [];
  return [
    `${String(others)} other active session(s) use this project directory. ` +
      'Do not let agents in different sessions modify the same working tree at the same time.',
  ];
}

/**
 * Session operations for a ChatGPT conversation. Every call except create and list requires
 * the session id and its token, so a conversation can only reach sessions it was given.
 * A wrong id or a wrong token produce the same SESSION_NOT_FOUND error.
 */
export class SessionManager {
  readonly #store: SessionStore;
  readonly #projects: ProjectRegistry;
  readonly #actor: Actor;
  readonly #allowMcpRegistration: boolean;
  readonly #isKnownAgent: (agentId: string) => boolean;
  readonly #random: RandomBytes | undefined;

  constructor(deps: SessionManagerDeps) {
    this.#store = new SessionStore(deps.db, deps.now ?? (() => new Date()), deps.randomBytes);
    this.#projects = deps.projects;
    this.#actor = deps.actor;
    this.#allowMcpRegistration = deps.allowMcpRegistration ?? false;
    this.#isKnownAgent = deps.isKnownAgent ?? ((id) => BUILTIN_AGENTS.some((d) => d.id === id));
    this.#random = deps.randomBytes;
  }

  #requireKnownAgent(agentId: string): void {
    if (!this.#isKnownAgent(agentId)) {
      throw new UabError(ErrorCode.AGENT_NOT_FOUND, 'Unknown or disabled agent.', {
        details: { agentId },
      });
    }
  }

  #resolveProject(ref: string): Project {
    try {
      return this.#projects.resolve(ref);
    } catch (error) {
      const canRegister = this.#actor === 'mcp' && this.#allowMcpRegistration;
      if (
        !canRegister ||
        !(error instanceof UabError) ||
        error.code !== ErrorCode.PROJECT_NOT_FOUND
      ) {
        throw error;
      }
      return this.#projects.register(ref).project;
    }
  }

  #authenticate(ref: unknown): SessionRow {
    const parsed = sessionRefSchema.safeParse(ref);
    if (!parsed.success) throw sessionNotFound();
    const row = this.#store.row(parsed.data.sessionId);
    if (!tokenMatches(parsed.data.sessionToken, row?.token_hash) || row === undefined) {
      throw sessionNotFound();
    }
    return row;
  }

  #requireActive(row: SessionRow): void {
    if (row.status !== 'active') {
      throw new UabError(ErrorCode.SESSION_CLOSED, 'The session is closed.', {
        details: { sessionId: row.id },
      });
    }
  }

  /**
   * Creates a session bound to an explicitly given project directory and agent. The project
   * must already be registered (`uab project add`) unless MCP registration is enabled.
   */
  create(input: unknown): CreatedSession {
    const {
      project: projectRef,
      agentId,
      title,
    } = parseInput(createSessionSchema, input, 'session');
    this.#requireKnownAgent(agentId);
    const project = this.#resolveProject(projectRef);
    const sessionToken = newSessionToken(this.#random);

    const sessionId = this.#store.db.transaction(() => {
      const id = this.#store.newSessionId();
      this.#store.insertSession({
        id,
        tokenHash: hashSessionToken(sessionToken),
        projectId: project.id,
        agentId,
        title: title ?? null,
      });
      this.#store.addEvent(id, this.#actor, 'created', { agentId, projectId: project.id });
      return id;
    });

    const session = this.#store.details(sessionId);
    return {
      session,
      sessionToken,
      warnings: concurrencyWarnings(session.otherActiveSessionsOnProject),
    };
  }

  /** Lists sessions without private details (no tokens, paths or history). */
  list(options: { includeClosed?: boolean } = {}): SessionSummary[] {
    return this.#store.summaries(options.includeClosed === true);
  }

  get(ref: unknown): SessionDetails {
    return this.#store.details(this.#authenticate(ref).id);
  }

  /** Re-attaches a conversation to an active session after verifying its token. */
  resume(ref: unknown): { session: SessionDetails; warnings: readonly string[] } {
    const row = this.#authenticate(ref);
    this.#requireActive(row);
    this.#store.db.transaction(() => {
      this.#store.touch(row.id);
      this.#store.addEvent(row.id, this.#actor, 'resumed');
    });
    const session = this.#store.details(row.id);
    return { session, warnings: concurrencyWarnings(session.otherActiveSessionsOnProject) };
  }

  /** Closes the session. Closing an already closed session is a no-op. */
  close(ref: unknown): SessionDetails {
    const row = this.#authenticate(ref);
    this.#store.db.transaction(() => {
      if (this.#store.closeSession(row.id)) {
        this.#store.addEvent(row.id, this.#actor, 'closed');
      }
    });
    return this.#store.details(row.id);
  }

  /**
   * Changes the session's current agent. The previous agent's native session stays attached
   * to that agent; nothing from it is passed to the new agent.
   */
  switchAgent(ref: unknown, agentIdInput: unknown): { session: SessionDetails; changed: boolean } {
    const agentId = parseInput(agentIdSchema, agentIdInput, 'agent id');
    this.#requireKnownAgent(agentId);
    const row = this.#authenticate(ref);
    this.#requireActive(row);

    const changed = this.#store.db.transaction(() => {
      const current = this.#store.requireRow(row.id);
      this.#requireActive(current);
      if (current.agent_id === agentId) return false;
      this.#store.setAgent(row.id, agentId);
      this.#store.addEvent(row.id, this.#actor, 'agent_switched', {
        from: current.agent_id,
        to: agentId,
      });
      return true;
    });
    return { session: this.#store.details(row.id), changed };
  }

  history(ref: unknown, query?: unknown): SessionEventPage {
    return this.#store.events(this.#authenticate(ref).id, query);
  }
}
