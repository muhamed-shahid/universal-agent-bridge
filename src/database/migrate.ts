import { createHash } from 'node:crypto';
import { ErrorCode, UabError } from '../core/errors.js';
import type { Database } from './database.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface MigrationResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly applied: readonly number[];
  readonly backupFile: string | undefined;
}

export interface MigrateOptions {
  /** Called once before pending migrations are applied to a non-empty database. */
  readonly backup?: (fromVersion: number) => string;
  readonly now?: () => Date;
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

/** Checksum of a migration's SQL. Line endings are normalised so checkouts with CRLF match. */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function assertWellFormed(migrations: readonly Migration[]): void {
  migrations.forEach((m, index) => {
    if (m.version !== index + 1) {
      throw new Error(
        `Migrations must be numbered 1..n without gaps (found ${String(m.version)}).`,
      );
    }
  });
}

export function currentSchemaVersion(db: Database): number {
  const exists = db.get<{ n: number }>(
    "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'",
  );
  if (exists === undefined || exists.n === 0) return 0;
  return db.get<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations')?.v ?? 0;
}

/**
 * Applies pending migrations. Each migration runs in its own write transaction and is
 * re-checked inside it, so several UAB processes can start at the same time safely.
 * Refuses to run against a database created by a newer UAB or with edited migrations.
 */
export function migrate(
  db: Database,
  migrations: readonly Migration[],
  options: MigrateOptions = {},
): MigrationResult {
  assertWellFormed(migrations);
  const now = options.now ?? (() => new Date());
  const latest = migrations.length;

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);

  const applied = db.all<AppliedRow>(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
  );
  for (const row of applied) {
    if (row.version > latest) {
      throw new UabError(
        ErrorCode.DATABASE_TOO_NEW,
        'The database was created by a newer version of UAB. Upgrade UAB to use it.',
        { details: { databaseVersion: row.version, supportedVersion: latest } },
      );
    }
    const known = migrations[row.version - 1];
    if (known === undefined || migrationChecksum(known.sql) !== row.checksum) {
      throw new UabError(
        ErrorCode.DATABASE_SCHEMA_MISMATCH,
        'The database schema does not match this version of UAB.',
        { details: { version: row.version, name: row.name } },
      );
    }
  }

  const fromVersion = applied.at(-1)?.version ?? 0;
  const pending = migrations.filter((m) => m.version > fromVersion);
  if (pending.length === 0) {
    return { fromVersion, toVersion: fromVersion, applied: [], backupFile: undefined };
  }

  const backupFile =
    fromVersion > 0 && options.backup !== undefined ? options.backup(fromVersion) : undefined;

  const done: number[] = [];
  for (const migration of pending) {
    try {
      db.transaction(() => {
        const already = db.get<{ n: number }>(
          'SELECT count(*) AS n FROM schema_migrations WHERE version = ?',
          migration.version,
        );
        if (already !== undefined && already.n > 0) return; // applied by another process
        db.exec(migration.sql);
        db.run(
          'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
          migration.version,
          migration.name,
          migrationChecksum(migration.sql),
          now().toISOString(),
        );
        done.push(migration.version);
      });
    } catch (error) {
      throw new UabError(ErrorCode.DATABASE_MIGRATION_FAILED, 'A database migration failed.', {
        details: { version: migration.version, name: migration.name, backupFile },
        cause: error,
      });
    }
  }

  return { fromVersion, toVersion: latest, applied: done, backupFile };
}
