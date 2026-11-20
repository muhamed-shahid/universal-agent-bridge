import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { ErrorCode, UabError } from '../core/errors.js';

export type SqlParam = SQLInputValue;

export interface RunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export const MEMORY = ':memory:';

/**
 * Thin wrapper over `node:sqlite`. All SQL goes through prepared statements with bound
 * parameters; callers must never build SQL from input values.
 */
export class Database {
  readonly file: string;
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  #depth = 0;
  #open = true;

  private constructor(file: string, db: DatabaseSync) {
    this.file = file;
    this.#db = db;
  }

  /**
   * Opens (creating if needed) a database file and applies connection settings.
   * `file` must be absolute, or `:memory:` for tests.
   */
  static open(file: string, options: { busyTimeoutMs?: number } = {}): Database {
    if (file !== MEMORY && !path.isAbsolute(file)) {
      throw new UabError(ErrorCode.DATABASE_ERROR, 'Database path must be absolute.');
    }

    let created = false;
    if (file !== MEMORY) {
      // 0o700 / 0o600 apply on POSIX. On Windows the per-user data directory ACL applies.
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      created = !existsSync(file);
    }

    let raw: DatabaseSync;
    try {
      raw = new DatabaseSync(file, { enableForeignKeyConstraints: true });
    } catch (error) {
      throw new UabError(ErrorCode.DATABASE_ERROR, 'Database cannot be opened.', {
        details: { file },
        cause: error,
      });
    }

    if (created && process.platform !== 'win32') {
      chmodSync(file, 0o600);
    }

    const db = new Database(file, raw);
    try {
      db.exec(`PRAGMA busy_timeout = ${String(Math.trunc(options.busyTimeoutMs ?? 5000))}`);
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('PRAGMA trusted_schema = OFF');
      if (file !== MEMORY) {
        db.get('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = NORMAL');
      }
    } catch (error) {
      db.close();
      throw new UabError(ErrorCode.DATABASE_ERROR, 'Database cannot be configured.', {
        details: { file },
        cause: error,
      });
    }
    return db;
  }

  get isOpen(): boolean {
    return this.#open;
  }

  get inTransaction(): boolean {
    return this.#depth > 0;
  }

  #statement(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  /** Returns the first row, typed by the caller. Column names must match `T`. */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- caller-declared row type.
  get<T extends object>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.#statement(sql).get(...params) as T | undefined;
  }

  all<T extends object>(sql: string, ...params: SqlParam[]): T[] {
    return this.#statement(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SqlParam[]): RunResult {
    const result = this.#statement(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  /** Executes trusted, constant SQL (schema and pragmas). Never pass input values. */
  exec(sql: string): void {
    this.#db.exec(sql);
  }

  /**
   * Runs `fn` in a write transaction (`BEGIN IMMEDIATE`, so the write lock is taken up front
   * and concurrent writers wait for `busy_timeout`). Nested calls use savepoints.
   * `fn` must be synchronous.
   */
  transaction<T>(fn: () => T): T {
    const level = this.#depth;
    this.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT sp${String(level)}`);
    this.#depth = level + 1;
    try {
      const result = fn();
      if (result instanceof Promise) {
        throw new TypeError('Database.transaction callback must be synchronous.');
      }
      this.exec(level === 0 ? 'COMMIT' : `RELEASE sp${String(level)}`);
      this.#depth = level;
      return result;
    } catch (error) {
      this.#depth = level;
      try {
        if (level === 0) {
          this.exec('ROLLBACK');
        } else {
          this.exec(`ROLLBACK TO sp${String(level)}`);
          this.exec(`RELEASE sp${String(level)}`);
        }
      } catch {
        // SQLite may already have rolled back (for example after SQLITE_FULL).
      }
      throw error;
    }
  }

  /** Writes a consistent copy of the database to `target` (must not exist). */
  backupTo(target: string): void {
    if (!path.isAbsolute(target)) {
      throw new UabError(ErrorCode.INVALID_ARGUMENT, 'Backup path must be absolute.');
    }
    if (existsSync(target)) {
      throw new UabError(ErrorCode.INVALID_ARGUMENT, 'Backup file already exists.', {
        details: { target },
      });
    }
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    this.run('VACUUM INTO ?', target);
    if (process.platform !== 'win32') {
      chmodSync(target, 0o600);
    }
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#statements.clear();
    this.#db.close();
  }
}
