import { readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Database,
  MEMORY,
  MIGRATIONS,
  currentSchemaVersion,
  migrate,
  migrationChecksum,
  type Migration,
} from '../../../src/database/index.js';
import { openDatabase } from '../../../src/database/index.js';
import { makeTempDir, removeDir } from '../../helpers/fs.js';

const V1: Migration = { version: 1, name: 'one', sql: 'CREATE TABLE a (x INTEGER) STRICT;' };
const V2: Migration = { version: 2, name: 'two', sql: 'CREATE TABLE b (y INTEGER) STRICT;' };

function tables(db: Database): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .map((r) => r.name);
}

describe('migrate', () => {
  let db: Database;
  beforeEach(() => {
    db = Database.open(MEMORY);
  });
  afterEach(() => {
    db.close();
  });

  it('applies the real migrations to an empty database', () => {
    const result = migrate(db, MIGRATIONS);
    expect(result).toMatchObject({ fromVersion: 0, toVersion: MIGRATIONS.length });
    expect(currentSchemaVersion(db)).toBe(MIGRATIONS.length);
    expect(tables(db)).toEqual(
      expect.arrayContaining(['projects', 'sessions', 'session_agents', 'session_events']),
    );
  });

  it('is idempotent', () => {
    migrate(db, MIGRATIONS);
    expect(migrate(db, MIGRATIONS).applied).toEqual([]);
  });

  it('reports version 0 before any migration', () => {
    expect(currentSchemaVersion(db)).toBe(0);
  });

  it('applies only pending migrations and backs up first', () => {
    migrate(db, [V1]);
    const backups: number[] = [];
    const result = migrate(db, [V1, V2], {
      backup: (v) => (backups.push(v), `backup-v${String(v)}`),
    });
    expect(result).toEqual({ fromVersion: 1, toVersion: 2, applied: [2], backupFile: 'backup-v1' });
    expect(backups).toEqual([1]);
  });

  it('does not back up a brand-new database', () => {
    const backups: number[] = [];
    migrate(db, [V1], { backup: (v) => (backups.push(v), 'x') });
    expect(backups).toEqual([]);
  });

  it('refuses a database created by a newer UAB', () => {
    migrate(db, [V1, V2]);
    expect(() => migrate(db, [V1])).toThrow(expect.objectContaining({ code: 'DATABASE_TOO_NEW' }));
  });

  it('refuses when an applied migration was edited', () => {
    migrate(db, [V1]);
    const edited = { ...V1, sql: 'CREATE TABLE a (x TEXT) STRICT;' };
    expect(() => migrate(db, [edited])).toThrow(
      expect.objectContaining({ code: 'DATABASE_SCHEMA_MISMATCH' }),
    );
  });

  it('rolls back a failing migration completely', () => {
    migrate(db, [V1]);
    const bad: Migration = {
      version: 2,
      name: 'bad',
      sql: 'CREATE TABLE c (z INTEGER) STRICT; INSERT INTO missing VALUES (1);',
    };
    expect(() => migrate(db, [V1, bad])).toThrow(
      expect.objectContaining({ code: 'DATABASE_MIGRATION_FAILED' }),
    );
    expect(tables(db)).not.toContain('c');
    expect(currentSchemaVersion(db)).toBe(1);
  });

  it('rejects badly numbered migration lists', () => {
    expect(() => migrate(db, [V2])).toThrow(/without gaps/);
  });

  it('normalises line endings in checksums', () => {
    expect(migrationChecksum('a\r\nb')).toBe(migrationChecksum('a\nb'));
  });
});

describe('openDatabase', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir('uab-open-');
  });
  afterEach(() => {
    removeDir(dir);
  });

  it('writes a backup file before upgrading an existing database', () => {
    const file = path.join(dir, 'uab.db');
    openDatabase(file, { migrations: [V1] }).db.close();
    const { db, migration } = openDatabase(file, {
      migrations: [V1, V2],
      now: () => new Date('2026-02-03T04:05:06.007Z'),
    });
    db.close();
    expect(migration.backupFile).toBe(`${file}.v1-2026-02-03T04-05-06-007Z.bak`);
    expect(readdirSync(dir)).toContain('uab.db.v1-2026-02-03T04-05-06-007Z.bak');

    const backup = Database.open(migration.backupFile ?? '');
    expect(currentSchemaVersion(backup)).toBe(1);
    backup.close();
  });

  it('lets two connections migrate the same file without conflict', () => {
    const file = path.join(dir, 'uab.db');
    const a = Database.open(file);
    const b = Database.open(file);
    migrate(a, MIGRATIONS);
    expect(migrate(b, MIGRATIONS).applied).toEqual([]);
    a.close();
    b.close();
  });
});
