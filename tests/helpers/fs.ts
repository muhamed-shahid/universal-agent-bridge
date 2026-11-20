import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Creates a temporary directory and returns its canonical path (8.3 names expanded). */
export function makeTempDir(prefix = 'uab-test-'): string {
  return realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

export function makeDir(...parts: string[]): string {
  const dir = path.join(...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function makeFile(file: string, content = 'x'): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

/**
 * Creates a directory link. Uses a junction on Windows (no admin rights or developer mode
 * needed) and a symlink elsewhere. Both are followed by realpath, which is what UAB checks.
 */
export function linkDir(target: string, link: string): void {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Creates a file symlink, or returns false when the OS does not permit it (Windows). */
export function tryLinkFile(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, 'file');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
}

/** Isolated environment: fake home, UAB data dir and a scratch area for projects. */
export interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly dataDir: string;
  readonly work: string;
  project(name: string): string;
  cleanup(): void;
}

export function createSandbox(): Sandbox {
  const root = makeTempDir();
  const home = makeDir(root, 'home');
  const dataDir = makeDir(root, 'uab-data');
  const work = makeDir(root, 'work');
  return {
    root,
    home,
    dataDir,
    work,
    project: (name) => makeDir(work, name),
    cleanup: () => {
      removeDir(root);
    },
  };
}
