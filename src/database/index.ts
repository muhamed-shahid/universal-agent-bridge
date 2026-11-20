import path from 'node:path';
import { Database, MEMORY } from './database.js';
import { migrate, type Migration, type MigrationResult } from './migrate.js';
import { MIGRATIONS } from './migrations.js';

export const DATABASE_FILE_NAME = 'uab.db';

export function databaseFile(dataDir: string): string {
  return path.join(dataDir, DATABASE_FILE_NAME);
}

function timestampForFile(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export interface OpenedDatabase {
  readonly db: Database;
  readonly migration: MigrationResult;
}

/**
 * Opens the UAB database and brings its schema up to date. Before migrating an existing
 * database, a backup copy is written next to it (`uab.db.v<N>-<timestamp>.bak`).
 */
export function openDatabase(
  file: string,
  options: { migrations?: readonly Migration[]; now?: () => Date } = {},
): OpenedDatabase {
  const now = options.now ?? (() => new Date());
  const db = Database.open(file);
  try {
    const migration = migrate(db, options.migrations ?? MIGRATIONS, {
      now,
      ...(file === MEMORY
        ? {}
        : {
            backup: (fromVersion: number) => {
              const target = `${file}.v${String(fromVersion)}-${timestampForFile(now())}.bak`;
              db.backupTo(target);
              return target;
            },
          }),
    });
    return { db, migration };
  } catch (error) {
    db.close();
    throw error;
  }
}

export { Database, MEMORY } from './database.js';
export { MIGRATIONS } from './migrations.js';
export { currentSchemaVersion, migrate, migrationChecksum, type Migration } from './migrate.js';
