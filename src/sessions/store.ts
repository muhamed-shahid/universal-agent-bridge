import { ErrorCode, UabError } from '../core/errors.js';
import { randomId, type RandomBytes } from '../core/ids.js';
import { parseInput } from '../core/validation.js';
import type { Database } from '../database/index.js';
import {
  historyQuerySchema,
  type Actor,
  type SessionAgentUsage,
  type SessionDetails,
  type SessionEvent,
  type SessionEventPage,
  type SessionStatus,
  type SessionSummary,
} from './types.js';

export interface SessionRow {
  id: string;
  token_hash: string;
  project_id: string;
  agent_id: string;
  title: string | null;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  last_used_at: string;
  closed_at: string | null;
}

interface SummaryRow {
  id: string;
  title: string | null;
  status: SessionStatus;
  agent_id: string;
  project_name: string;
  created_at: string;
  last_used_at: string;
}

interface AgentRow {
  agent_id: string;
  first_used_at: string;
  last_used_at: string;
  native_session_id: string | null;
}

interface EventRow {
  id: number;
  ts: string;
  actor: Actor;
  type: string;
  data: string;
}

const SESSION_COLUMNS =
  'id, token_hash, project_id, agent_id, title, status, created_at, updated_at, last_used_at, closed_at';

export function sessionNotFound(): UabError {
  // Same error for unknown ids and wrong tokens, so session ids cannot be probed.
  return new UabError(ErrorCode.SESSION_NOT_FOUND, 'Session not found or token invalid.');
}

/** Shared persistence for SessionManager (token-bound) and SessionAdmin (operator). */
export class SessionStore {
  readonly db: Database;
  readonly now: () => Date;
  readonly #random: RandomBytes | undefined;

  constructor(db: Database, now: () => Date, random?: RandomBytes) {
    this.db = db;
    this.now = now;
    this.#random = random;
  }

  timestamp(): string {
    return this.now().toISOString();
  }

  newSessionId(): string {
    return randomId('UAB-', 12, this.#random);
  }

  row(id: string): SessionRow | undefined {
    return this.db.get<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`, id);
  }

  requireRow(id: string): SessionRow {
    const row = this.row(id);
    if (row === undefined) throw sessionNotFound();
    return row;
  }

  insertSession(values: {
    id: string;
    tokenHash: string;
    projectId: string;
    agentId: string;
    title: string | null;
  }): void {
    const ts = this.timestamp();
    this.db.run(
      `INSERT INTO sessions (id, token_hash, project_id, agent_id, title, status,
                             created_at, updated_at, last_used_at, closed_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)`,
      values.id,
      values.tokenHash,
      values.projectId,
      values.agentId,
      values.title,
      ts,
      ts,
      ts,
    );
    this.useAgent(values.id, values.agentId);
  }

  /** Records that `agentId` is used by the session (keeps its own native session slot). */
  useAgent(sessionId: string, agentId: string): void {
    const ts = this.timestamp();
    this.db.run(
      `INSERT INTO session_agents (session_id, agent_id, native_session_id, first_used_at, last_used_at)
       VALUES (?, ?, NULL, ?, ?)
       ON CONFLICT (session_id, agent_id) DO UPDATE SET last_used_at = excluded.last_used_at`,
      sessionId,
      agentId,
      ts,
      ts,
    );
  }

  touch(sessionId: string): void {
    this.db.run('UPDATE sessions SET last_used_at = ? WHERE id = ?', this.timestamp(), sessionId);
  }

  setAgent(sessionId: string, agentId: string): void {
    const ts = this.timestamp();
    this.db.run(
      'UPDATE sessions SET agent_id = ?, updated_at = ?, last_used_at = ? WHERE id = ?',
      agentId,
      ts,
      ts,
      sessionId,
    );
    this.useAgent(sessionId, agentId);
  }

  setTokenHash(sessionId: string, tokenHash: string): void {
    this.db.run(
      'UPDATE sessions SET token_hash = ?, updated_at = ? WHERE id = ?',
      tokenHash,
      this.timestamp(),
      sessionId,
    );
  }

  closeSession(sessionId: string): boolean {
    const ts = this.timestamp();
    return (
      this.db.run(
        `UPDATE sessions SET status = 'closed', closed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`,
        ts,
        ts,
        sessionId,
      ).changes === 1
    );
  }

  addEvent(
    sessionId: string,
    actor: Actor,
    type: string,
    data: Record<string, unknown> = {},
  ): void {
    this.db.run(
      'INSERT INTO session_events (session_id, ts, actor, type, data) VALUES (?, ?, ?, ?, ?)',
      sessionId,
      this.timestamp(),
      actor,
      type,
      JSON.stringify(data),
    );
  }

  events(sessionId: string, query: unknown): SessionEventPage {
    const { cursor, limit } = parseInput(historyQuerySchema, query ?? {}, 'history query');
    const after = cursor === undefined ? 0 : Number(cursor);
    const rows = this.db.all<EventRow>(
      `SELECT id, ts, actor, type, data FROM session_events
       WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?`,
      sessionId,
      after,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const events: SessionEvent[] = page.map((r) => ({
      id: r.id,
      ts: r.ts,
      actor: r.actor,
      type: r.type,
      data: JSON.parse(r.data) as Record<string, unknown>,
    }));
    const last = page.at(-1);
    return {
      events,
      nextCursor: rows.length > limit && last !== undefined ? String(last.id) : null,
    };
  }

  otherActiveOnProject(projectId: string, excludeSessionId: string): number {
    return (
      this.db.get<{ n: number }>(
        `SELECT count(*) AS n FROM sessions
         WHERE project_id = ? AND status = 'active' AND id <> ?`,
        projectId,
        excludeSessionId,
      )?.n ?? 0
    );
  }

  summaries(includeClosed: boolean): SessionSummary[] {
    return this.db
      .all<SummaryRow>(
        `SELECT s.id, s.title, s.status, s.agent_id, p.display_name AS project_name,
                s.created_at, s.last_used_at
         FROM sessions s JOIN projects p ON p.id = s.project_id
         WHERE (? = 1 OR s.status = 'active')
         ORDER BY s.last_used_at DESC, s.id`,
        includeClosed ? 1 : 0,
      )
      .map((r) => ({
        sessionId: r.id,
        title: r.title,
        status: r.status,
        agentId: r.agent_id,
        projectName: r.project_name,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
      }));
  }

  details(sessionId: string): SessionDetails {
    const row = this.requireRow(sessionId);
    const project = this.db.get<{ id: string; display_name: string; canonical_path: string }>(
      'SELECT id, display_name, canonical_path FROM projects WHERE id = ?',
      row.project_id,
    );
    if (project === undefined) throw new Error('Session project missing.');
    const agents: SessionAgentUsage[] = this.db
      .all<AgentRow>(
        `SELECT agent_id, first_used_at, last_used_at, native_session_id
         FROM session_agents WHERE session_id = ? ORDER BY first_used_at, agent_id`,
        sessionId,
      )
      .map((a) => ({
        agentId: a.agent_id,
        firstUsedAt: a.first_used_at,
        lastUsedAt: a.last_used_at,
        hasNativeSession: a.native_session_id !== null,
      }));
    return {
      sessionId: row.id,
      title: row.title,
      status: row.status,
      agentId: row.agent_id,
      projectName: project.display_name,
      project: { id: project.id, name: project.display_name, path: project.canonical_path },
      agents,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
      closedAt: row.closed_at,
      otherActiveSessionsOnProject: this.otherActiveOnProject(row.project_id, row.id),
    };
  }
}
