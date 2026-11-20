import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database, MEMORY } from '../../../src/database/index.js';
import { makeTempDir, removeDir } from '../../helpers/fs.js';

describe('Database', () => {
  let dir: string;
  let db: Database | undefined;

  beforeEach(() => {
    dir = makeTempDir('uab-db-');
  });
  afterEach(() => {
    db?.close();
    db = undefined;
    removeDir(dir);
  });

  it('requires an absolute file path', () => {
    expect(() => Database.open('relative.db')).toThrow(/absolute/);
  });

  it('creates the file and parent directories, enables WAL and foreign keys', () => {
    const file = path.join(dir, 'nested', 'uab.db');
    db = Database.open(file);
    expect(existsSync(file)).toBe(true);
    expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
    expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1);
    expect(db.get<{ timeout: number }>('PRAGMA busy_timeout')?.timeout).toBe(5000);
  });

  it('binds parameters instead of interpolating them', () => {
    db = Database.open(MEMORY);
    db.exec('CREATE TABLE t (v TEXT) STRICT');
    const hostile = "x'); DROP TABLE t; --";
    db.run('INSERT INTO t (v) VALUES (?)', hostile);
    expect(db.all<{ v: string }>('SELECT v FROM t')).toEqual([{ v: hostile }]);
  });

  describe('transaction', () => {
    let t: Database;
    beforeEach(() => {
      t = Database.open(MEMORY);
      db = t;
      t.exec('CREATE TABLE t (v INTEGER) STRICT');
    });
    const count = () => t.get<{ n: number }>('SELECT count(*) AS n FROM t')?.n;

    it('commits on success and returns the callback value', () => {
      const value = t.transaction(() => {
        t.run('INSERT INTO t VALUES (1)');
        return 'ok';
      });
      expect(value).toBe('ok');
      expect(count()).toBe(1);
      expect(t.inTransaction).toBe(false);
    });

    it('rolls back everything on error', () => {
      expect(() =>
        t.transaction(() => {
          t.run('INSERT INTO t VALUES (1)');
          throw new Error('boom');
        }),
      ).toThrow('boom');
      expect(count()).toBe(0);
      expect(t.inTransaction).toBe(false);
    });

    it('rolls back only the inner savepoint when a nested transaction fails', () => {
      t.transaction(() => {
        t.run('INSERT INTO t VALUES (1)');
        expect(() =>
          t.transaction(() => {
            t.run('INSERT INTO t VALUES (2)');
            throw new Error('inner');
          }),
        ).toThrow('inner');
        t.run('INSERT INTO t VALUES (3)');
      });
      expect(t.all<{ v: number }>('SELECT v FROM t ORDER BY v')).toEqual([{ v: 1 }, { v: 3 }]);
    });

    it('rejects async callbacks and rolls back', () => {
      expect(() =>
        t.transaction(() => {
          t.run('INSERT INTO t VALUES (1)');
          return Promise.resolve();
        }),
      ).toThrow(/synchronous/);
      expect(count()).toBe(0);
    });
  });

  it('writes a consistent backup and refuses to overwrite one', () => {
    db = Database.open(path.join(dir, 'uab.db'));
    db.exec('CREATE TABLE t (v INTEGER) STRICT; INSERT INTO t VALUES (7)');
    const target = path.join(dir, 'backups', 'copy.db');
    db.backupTo(target);
    const copy = Database.open(target);
    expect(copy.get<{ v: number }>('SELECT v FROM t')?.v).toBe(7);
    copy.close();
    expect(() => db?.backupTo(target)).toThrow(/already exists/);
    expect(() => db?.backupTo('relative.db')).toThrow(/absolute/);
  });

  it('close is idempotent', () => {
    db = Database.open(MEMORY);
    db.close();
    db.close();
    expect(db.isOpen).toBe(false);
  });
});
