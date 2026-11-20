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
  {
    version: 2,
    name: 'tasks_approvals_executions',
    sql: `
-- Optional verification command per project, set only by the local user (uab project set-test).
ALTER TABLE projects ADD COLUMN test_command TEXT;

CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  agent_id        TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('implement', 'fix', 'review', 'test', 'summarize', 'diagnose')),
  title           TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN (
                    'pending_approval', 'changes_requested', 'approved', 'rejected', 'expired',
                    'running', 'succeeded', 'failed', 'permission_denied', 'timed_out',
                    'cancelled', 'interrupted')),
  status_note     TEXT,
  current_version INTEGER NOT NULL,
  parent_task_id  TEXT REFERENCES tasks (id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;

CREATE INDEX tasks_by_session ON tasks (session_id, created_at);
CREATE INDEX tasks_by_status ON tasks (status);

-- Prompt versions are immutable. The approval binds to (task, version, sha256).
CREATE TABLE task_prompt_versions (
  task_id       TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  prompt        TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  note          TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (task_id, version)
) STRICT;

CREATE TABLE approvals (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  session_id     TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  project_path   TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  prompt_sha256  TEXT NOT NULL,
  decision       TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'changes_requested')),
  channel        TEXT NOT NULL CHECK (channel IN ('local', 'chat')),
  note           TEXT,
  decided_at     TEXT NOT NULL,
  expires_at     TEXT,
  consumed_at    TEXT
) STRICT;

CREATE INDEX approvals_by_task ON approvals (task_id, decided_at);
-- At most one usable approval per task and prompt version.
CREATE UNIQUE INDEX approvals_one_open ON approvals (task_id, prompt_version)
  WHERE decision = 'approved';

CREATE TABLE executions (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL UNIQUE REFERENCES tasks (id) ON DELETE CASCADE,
  approval_id      TEXT NOT NULL UNIQUE REFERENCES approvals (id),
  session_id       TEXT NOT NULL,
  agent_id         TEXT NOT NULL,
  mode             TEXT NOT NULL CHECK (mode IN ('read_only', 'workspace_write')),
  status           TEXT NOT NULL CHECK (status IN (
                     'running', 'succeeded', 'failed', 'permission_denied', 'timed_out',
                     'cancelled', 'interrupted')),
  owner_pid        INTEGER NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  started_at       TEXT NOT NULL,
  heartbeat_at     TEXT NOT NULL,
  ended_at         TEXT,
  exit_code        INTEGER,
  duration_ms      INTEGER,
  error            TEXT
) STRICT;

CREATE INDEX executions_by_status ON executions (status);

-- Redacted output. stream: stdout | stderr | uab (messages from UAB itself).
CREATE TABLE execution_output (
  execution_id TEXT NOT NULL REFERENCES executions (id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  stream       TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'uab')),
  ts           TEXT NOT NULL,
  chunk        TEXT NOT NULL,
  PRIMARY KEY (execution_id, seq)
) STRICT;

CREATE TABLE execution_results (
  execution_id TEXT PRIMARY KEY REFERENCES executions (id) ON DELETE CASCADE,
  data         TEXT NOT NULL
) STRICT;

CREATE TABLE worktree_locks (
  path_key     TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions (id) ON DELETE CASCADE,
  owner_pid    INTEGER NOT NULL,
  acquired_at  TEXT NOT NULL
) STRICT;

-- Append-only audit trail of decisions and executions.
CREATE TABLE audit_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  actor      TEXT NOT NULL CHECK (actor IN ('mcp', 'cli', 'system')),
  action     TEXT NOT NULL,
  session_id TEXT,
  task_id    TEXT,
  data       TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
`,
  },
];
