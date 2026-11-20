import path from 'node:path';
import { z } from 'zod';
import { ErrorCode, UabError } from '../core/errors.js';
import { randomId, type RandomBytes } from '../core/ids.js';
import { CONTROL_CHARS, parseInput } from '../core/validation.js';
import type { Database } from '../database/index.js';
import { pathKey, validateProjectRoot, type ProjectRootPolicy } from '../security/paths.js';

export interface Project {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ProjectRow {
  id: string;
  canonical_path: string;
  display_name: string;
  created_at: string;
  updated_at: string;
}

export const PROJECT_ID_PATTERN = /^PRJ-[0-9A-HJKMNP-TV-Z]{10}$/;

export const projectNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((v) => !CONTROL_CHARS.test(v), 'must not contain control characters');

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    path: row.canonical_path,
    name: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT = 'SELECT id, canonical_path, display_name, created_at, updated_at FROM projects';

export interface ProjectRegistryDeps {
  readonly db: Database;
  readonly policy: ProjectRootPolicy;
  readonly now?: () => Date;
  readonly randomBytes?: RandomBytes;
}

/** Registered project directories. Only canonical, policy-checked paths are stored. */
export class ProjectRegistry {
  readonly #db: Database;
  readonly #policy: ProjectRootPolicy;
  readonly #now: () => Date;
  readonly #random: RandomBytes | undefined;
  readonly #platform: NodeJS.Platform;

  constructor(deps: ProjectRegistryDeps) {
    this.#db = deps.db;
    this.#policy = deps.policy;
    this.#now = deps.now ?? (() => new Date());
    this.#random = deps.randomBytes;
    this.#platform = deps.policy.platform ?? process.platform;
  }

  /** Validates and canonicalises a directory path without registering it. */
  canonicalize(inputPath: unknown): string {
    return validateProjectRoot(inputPath, this.#policy);
  }

  /**
   * Registers a directory, or returns the existing registration for the same canonical path.
   * `created` tells the caller which happened.
   */
  register(inputPath: unknown, name?: unknown): { project: Project; created: boolean } {
    const canonical = this.canonicalize(inputPath);
    const displayName =
      name === undefined
        ? (path.basename(canonical) || canonical).slice(0, 80)
        : parseInput(projectNameSchema, name, 'project name');
    const key = pathKey(canonical, this.#platform);

    return this.#db.transaction(() => {
      const existing = this.#db.get<ProjectRow>(`${SELECT} WHERE path_key = ?`, key);
      if (existing !== undefined) return { project: toProject(existing), created: false };

      const ts = this.#now().toISOString();
      const id = randomId('PRJ-', 10, this.#random);
      this.#db.run(
        `INSERT INTO projects (id, canonical_path, path_key, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        canonical,
        key,
        displayName,
        ts,
        ts,
      );
      const project = this.get(id);
      if (project === undefined) throw new Error('Inserted project not found.');
      return { project, created: true };
    });
  }

  get(id: string): Project | undefined {
    const row = this.#db.get<ProjectRow>(`${SELECT} WHERE id = ?`, id);
    return row === undefined ? undefined : toProject(row);
  }

  /** Finds a registered project by directory path (canonicalised first). */
  findByPath(inputPath: unknown): Project | undefined {
    let canonical: string;
    try {
      canonical = this.canonicalize(inputPath);
    } catch {
      return undefined;
    }
    const row = this.#db.get<ProjectRow>(
      `${SELECT} WHERE path_key = ?`,
      pathKey(canonical, this.#platform),
    );
    return row === undefined ? undefined : toProject(row);
  }

  /**
   * Resolves an operator reference: a project id (`PRJ-…`) or a directory path.
   * Throws PROJECT_NOT_FOUND if neither matches a registered project.
   */
  resolve(ref: string): Project {
    const project = PROJECT_ID_PATTERN.test(ref) ? this.get(ref) : this.findByPath(ref);
    if (project === undefined) {
      throw new UabError(ErrorCode.PROJECT_NOT_FOUND, 'Project is not registered.', {
        details: { hint: 'Register it with: uab project add <absolute-path>' },
      });
    }
    return project;
  }

  list(): Project[] {
    return this.#db.all<ProjectRow>(`${SELECT} ORDER BY display_name, created_at`).map(toProject);
  }

  /**
   * Sets the command UAB runs after write tasks to verify the result independently (for example
   * `npm test`). Arguments only, no shell. Set by the local user; never by ChatGPT.
   */
  setTestCommand(id: string, argv: readonly string[] | null): void {
    if (argv !== null) {
      if (
        argv.length === 0 ||
        argv.length > 32 ||
        argv.some((a) => a.length > 512 || CONTROL_CHARS.test(a))
      ) {
        throw new UabError(ErrorCode.INVALID_ARGUMENT, 'Invalid test command.');
      }
    }
    const changed = this.#db.run(
      'UPDATE projects SET test_command = ?, updated_at = ? WHERE id = ?',
      argv === null ? null : JSON.stringify(argv),
      this.#now().toISOString(),
      id,
    ).changes;
    if (changed === 0)
      throw new UabError(ErrorCode.PROJECT_NOT_FOUND, 'Project is not registered.');
  }

  testCommand(id: string): string[] | null {
    const row = this.#db.get<{ test_command: string | null }>(
      'SELECT test_command FROM projects WHERE id = ?',
      id,
    );
    return row?.test_command == null ? null : (JSON.parse(row.test_command) as string[]);
  }

  /** Removes a registration. Refused while any session (open or closed) references it. */
  remove(id: string): void {
    this.#db.transaction(() => {
      if (this.get(id) === undefined) {
        throw new UabError(ErrorCode.PROJECT_NOT_FOUND, 'Project is not registered.');
      }
      const used = this.#db.get<{ n: number }>(
        'SELECT count(*) AS n FROM sessions WHERE project_id = ?',
        id,
      );
      if (used !== undefined && used.n > 0) {
        throw new UabError(
          ErrorCode.PROJECT_IN_USE,
          'The project has sessions and cannot be removed.',
          { details: { sessions: used.n } },
        );
      }
      this.#db.run('DELETE FROM projects WHERE id = ?', id);
    });
  }
}
