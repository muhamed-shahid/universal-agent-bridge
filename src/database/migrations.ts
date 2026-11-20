import type { Migration } from './migrate.js';

/**
 * Schema migrations. Rules:
 * - Never edit a released migration; add a new one. Applied migrations are checksummed.
 * - Only constant SQL here. No user data.
 * - No table stores provider credentials. Session tokens are stored only as SHA-256 hashes.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'projects_and_sessions',
    sql: `
CREATE TABLE projects (
  id             TEXT PRIMARY KEY,
  canonical_path TEXT NOT NULL,
  -- Comparison key: canonical path, lower-cased on Windows (case-insensitive filesystem).
  path_key       TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL,
  project_id   TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  agent_id     TEXT NOT NULL,
  title        TEXT,
  status       TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  closed_at    TEXT
) STRICT;

CREATE INDEX sessions_by_project ON sessions (project_id, status);

-- One row per agent used in a session. Each agent keeps its own native session id, so
-- switching agents never hands one agent's conversation to another.
CREATE TABLE session_agents (
  session_id        TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  agent_id          TEXT NOT NULL,
  native_session_id TEXT,
  first_used_at     TEXT NOT NULL,
  last_used_at      TEXT NOT NULL,
  PRIMARY KEY (session_id, agent_id)
) STRICT;

-- Per-session history. Append-only. Never stores prompts, tokens or agent output.
CREATE TABLE session_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  ts         TEXT NOT NULL,
  actor      TEXT NOT NULL CHECK (actor IN ('mcp', 'cli', 'system')),
  type       TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE INDEX session_events_by_session ON session_events (session_id, id);
`,
  },
];
