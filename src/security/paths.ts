import { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { ErrorCode, UabError } from '../core/errors.js';
import { CONTROL_CHARS } from '../core/validation.js';

/**
 * Filesystem confinement for project directories.
 *
 * Threat model: paths come from ChatGPT (untrusted) or from project files and agent output.
 * Every path is canonicalised with the OS (`realpath`), which resolves symlinks, junctions,
 * `..`, 8.3 short names and letter case, before any containment check.
 */

const MAX_PATH_LENGTH = 4096;
const MAX_RELATIVE_LENGTH = 1024;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;

export interface ProjectRootPolicy {
  readonly homedir: string;
  /** UAB's own data directory; projects may not contain or live inside it. */
  readonly dataDir: string;
  readonly platform?: NodeJS.Platform;
}

function invalid(message: string, reason: string): UabError {
  return new UabError(ErrorCode.PROJECT_PATH_INVALID, message, { details: { reason } });
}

function outside(reason: string): UabError {
  return new UabError(ErrorCode.PATH_OUTSIDE_PROJECT, 'Path is not allowed.', {
    details: { reason },
  });
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return typeof error.code === 'string' ? error.code : undefined;
  }
  return undefined;
}

/** Comparison key for a canonical path: case-insensitive on Windows. */
export function pathKey(canonical: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/** True when `candidate` equals `root` or lies below it. Both must be canonical. */
export function isWithin(
  root: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const rel = p.relative(root, candidate);
  if (rel === '') return true;
  if (p.isAbsolute(rel)) return false; // different drive on Windows
  return rel !== '..' && !rel.startsWith(`..${p.sep}`);
}

function isWindowsDeviceOrUnc(value: string): boolean {
  // \\server\share, \\?\..., \\.\..., //server/share
  return /^[\\/]{2}/.test(value);
}

function canonicalOrThrowMissing(value: string): string {
  try {
    return realpathSync.native(value);
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw invalid('The project directory does not exist.', 'not_found');
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw invalid('The project directory cannot be accessed.', 'access_denied');
    }
    throw invalid('The project directory cannot be resolved.', 'unresolvable');
  }
}

function canonicalIfExists(value: string): string | undefined {
  try {
    return realpathSync.native(value);
  } catch {
    return undefined;
  }
}

/**
 * Validates a directory a user wants to register as a project and returns its canonical path.
 *
 * Rejected: relative paths, control characters, UNC and device paths (Windows), missing paths,
 * files, the filesystem root, the home directory or any parent of it, and anything that
 * overlaps UAB's data directory.
 */
export function validateProjectRoot(input: unknown, policy: ProjectRootPolicy): string {
  const platform = policy.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;

  if (typeof input !== 'string' || input.trim() === '') {
    throw invalid('A project directory path is required.', 'empty');
  }
  const value = input.trim();
  if (value.length > MAX_PATH_LENGTH) {
    throw invalid('The project directory path is too long.', 'too_long');
  }
  if (CONTROL_CHARS.test(value)) {
    throw invalid('The project directory path contains control characters.', 'control_chars');
  }
  if (platform === 'win32' && isWindowsDeviceOrUnc(value)) {
    throw invalid('Network (UNC) and device paths are not supported.', 'unc_or_device');
  }
  if (platform === 'win32' ? !/^[a-zA-Z]:[\\/]/.test(value) : !p.isAbsolute(value)) {
    throw invalid('The project directory must be an absolute path.', 'not_absolute');
  }

  const canonical = canonicalOrThrowMissing(value);
  if (platform === 'win32' && isWindowsDeviceOrUnc(canonical)) {
    // A symlink or junction that points at a network share.
    throw invalid('Network (UNC) and device paths are not supported.', 'unc_or_device');
  }
  if (!statSync(canonical).isDirectory()) {
    throw invalid('The project path is not a directory.', 'not_directory');
  }
  if (p.dirname(canonical) === canonical) {
    throw invalid('A filesystem root cannot be a project directory.', 'filesystem_root');
  }

  const home = canonicalIfExists(policy.homedir) ?? p.resolve(policy.homedir);
  if (isWithin(canonical, home, platform)) {
    throw invalid(
      'The home directory, or a directory that contains it, cannot be a project directory.',
      'contains_home',
    );
  }

  const dataDir = canonicalIfExists(policy.dataDir) ?? p.resolve(policy.dataDir);
  if (isWithin(canonical, dataDir, platform) || isWithin(dataDir, canonical, platform)) {
    throw invalid('The project directory overlaps the UAB data directory.', 'overlaps_data_dir');
  }

  return canonical;
}

/**
 * Validates the syntax of a project-relative path supplied by an untrusted caller and returns
 * its segments. Does not touch the filesystem. Rules are the same on every platform so a path
 * accepted on Linux cannot become dangerous on Windows.
 */
export function parseRelativePath(input: unknown): string[] {
  if (typeof input !== 'string') throw outside('not_a_string');
  if (input.length > MAX_RELATIVE_LENGTH) throw outside('too_long');
  if (CONTROL_CHARS.test(input)) throw outside('control_chars');
  if (/^[\\/]/.test(input)) throw outside('absolute');
  if (/^[a-zA-Z]:/.test(input)) throw outside('drive_letter');
  if (input.includes(':')) throw outside('colon'); // NTFS alternate data streams, drive tricks

  const segments: string[] = [];
  for (const segment of input.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') throw outside('parent_segment');
    if (/[. ]$/.test(segment)) throw outside('trailing_dot_or_space'); // Windows strips these
    if (WINDOWS_RESERVED.test(segment)) throw outside('reserved_name');
    segments.push(segment);
  }
  return segments;
}

export interface ResolvedProjectPath {
  /** Canonical absolute path (symlinks resolved as far as the path exists). */
  readonly absolute: string;
  /** Normalised project-relative path with forward slashes; '' for the root. */
  readonly relative: string;
  readonly exists: boolean;
}

/**
 * Resolves a project-relative path and proves it stays inside the project after symlink
 * resolution. For paths that do not exist yet, the nearest existing ancestor is resolved and
 * checked, so a symlinked parent directory cannot redirect a future write outside the root.
 *
 * `root` must be a canonical path returned by `validateProjectRoot`.
 */
export function resolveInProject(
  root: string,
  relativeInput: unknown,
  platform: NodeJS.Platform = process.platform,
): ResolvedProjectPath {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const segments = parseRelativePath(relativeInput);
  const joined = p.join(root, ...segments);
  if (!isWithin(root, joined, platform)) throw outside('lexical_escape');

  // Walk up to the nearest existing ancestor, then canonicalise it.
  let existing = joined;
  const missing: string[] = [];
  for (;;) {
    try {
      lstatSync(existing);
      break;
    } catch (error) {
      const code = errnoCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw outside('unreadable');
      if (existing === root) throw outside('root_missing');
      missing.unshift(p.basename(existing));
      existing = p.dirname(existing);
    }
  }

  let canonicalExisting: string;
  try {
    canonicalExisting = realpathSync.native(existing);
  } catch {
    // Dangling symlink: its target does not exist, so it cannot be proven safe.
    throw outside('dangling_symlink');
  }
  if (!isWithin(root, canonicalExisting, platform)) throw outside('symlink_escape');

  const absolute = missing.length === 0 ? canonicalExisting : p.join(canonicalExisting, ...missing);
  const relative = p.relative(root, absolute).split(p.sep).join('/');
  return { absolute, relative, exists: missing.length === 0 };
}
