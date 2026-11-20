import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isWithin,
  parseRelativePath,
  pathKey,
  resolveInProject,
  validateProjectRoot,
} from '../../src/security/paths.js';
import {
  createSandbox,
  linkDir,
  makeDir,
  makeFile,
  tryLinkFile,
  type Sandbox,
} from '../helpers/fs.js';

function reason(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    const e = error as { code?: string; details?: { reason?: string } };
    return `${e.code ?? '?'}:${e.details?.reason ?? '?'}`;
  }
  return undefined;
}

describe('validateProjectRoot', () => {
  let sb: Sandbox;
  let policy: { homedir: string; dataDir: string };
  beforeEach(() => {
    sb = createSandbox();
    policy = { homedir: sb.home, dataDir: sb.dataDir };
  });
  afterEach(() => {
    sb.cleanup();
  });

  it('returns the canonical path of a valid directory', () => {
    const dir = sb.project('app');
    expect(validateProjectRoot(dir, policy)).toBe(dir);
  });

  it('canonicalises redundant segments', () => {
    const dir = sb.project('app');
    expect(validateProjectRoot(path.join(sb.work, 'x', '..', 'app') + path.sep, policy)).toBe(dir);
  });

  it('accepts a project inside the home directory', () => {
    const dir = makeDir(sb.home, 'projects', 'app');
    expect(validateProjectRoot(dir, policy)).toBe(dir);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['relative/dir', 'not_absolute'],
    ['./app', 'not_absolute'],
    ['..', 'not_absolute'],
  ])('rejects %j (%s)', (input, why) => {
    expect(reason(() => validateProjectRoot(input, policy))).toBe(`PROJECT_PATH_INVALID:${why}`);
  });

  it.each([null, undefined, 42, {}, ['C:\\x']])('rejects non-string input %j', (input) => {
    expect(reason(() => validateProjectRoot(input, policy))).toBe('PROJECT_PATH_INVALID:empty');
  });

  it('rejects control characters and NUL bytes', () => {
    const dir = sb.project('app');
    expect(reason(() => validateProjectRoot(`${dir}\u0000evil`, policy))).toBe(
      'PROJECT_PATH_INVALID:control_chars',
    );
    expect(reason(() => validateProjectRoot(`${dir}\nother`, policy))).toBe(
      'PROJECT_PATH_INVALID:control_chars',
    );
  });

  it('rejects paths that do not exist', () => {
    expect(reason(() => validateProjectRoot(path.join(sb.work, 'missing'), policy))).toBe(
      'PROJECT_PATH_INVALID:not_found',
    );
  });

  it('rejects files', () => {
    const file = makeFile(path.join(sb.work, 'file.txt'));
    expect(reason(() => validateProjectRoot(file, policy))).toBe(
      'PROJECT_PATH_INVALID:not_directory',
    );
  });

  it('rejects the filesystem root', () => {
    const root = path.parse(sb.root).root;
    expect(reason(() => validateProjectRoot(root, policy))).toBe(
      'PROJECT_PATH_INVALID:filesystem_root',
    );
  });

  it('rejects the home directory and its parents', () => {
    expect(reason(() => validateProjectRoot(sb.home, policy))).toBe(
      'PROJECT_PATH_INVALID:contains_home',
    );
    expect(reason(() => validateProjectRoot(sb.root, policy))).toBe(
      'PROJECT_PATH_INVALID:contains_home',
    );
  });

  it('rejects the UAB data directory, folders inside it, and folders containing it', () => {
    const inside = makeDir(sb.dataDir, 'sub');
    const otherPolicy = {
      homedir: makeDir(sb.root, 'h2'),
      dataDir: makeDir(sb.work, 'nested', 'data'),
    };
    expect(reason(() => validateProjectRoot(sb.dataDir, policy))).toBe(
      'PROJECT_PATH_INVALID:overlaps_data_dir',
    );
    expect(reason(() => validateProjectRoot(inside, policy))).toBe(
      'PROJECT_PATH_INVALID:overlaps_data_dir',
    );
    expect(reason(() => validateProjectRoot(path.join(sb.work, 'nested'), otherPolicy))).toBe(
      'PROJECT_PATH_INVALID:overlaps_data_dir',
    );
  });

  it('resolves a linked directory to its real target and applies the policy to the target', () => {
    const real = sb.project('real');
    const link = path.join(sb.work, 'link');
    linkDir(real, link);
    expect(validateProjectRoot(link, policy)).toBe(real);

    const homeLink = path.join(sb.work, 'home-link');
    linkDir(sb.home, homeLink);
    expect(reason(() => validateProjectRoot(homeLink, policy))).toBe(
      'PROJECT_PATH_INVALID:contains_home',
    );
  });

  describe.runIf(process.platform === 'win32')('Windows', () => {
    it.each([
      '\\\\server\\share\\repo',
      '//server/share/repo',
      '\\\\?\\C:\\repo',
      '\\\\.\\C:\\repo',
    ])('rejects UNC and device path %s', (input) => {
      expect(reason(() => validateProjectRoot(input, policy))).toBe(
        'PROJECT_PATH_INVALID:unc_or_device',
      );
    });

    it.each(['C:repo', '\\repo'])('rejects drive-relative or root-relative path %s', (input) => {
      expect(reason(() => validateProjectRoot(input, policy))).toBe(
        'PROJECT_PATH_INVALID:not_absolute',
      );
    });

    it('treats different letter case as the same directory', () => {
      const dir = sb.project('CaseDir');
      expect(validateProjectRoot(dir.toLowerCase(), policy)).toBe(dir);
    });
  });
});

describe('parseRelativePath', () => {
  it.each([
    ['', []],
    ['.', []],
    ['src/index.ts', ['src', 'index.ts']],
    ['src\\core\\a.ts', ['src', 'core', 'a.ts']],
    ['./src//a.ts', ['src', 'a.ts']],
    ['.github/workflows', ['.github', 'workflows']],
    ['a..b/c', ['a..b', 'c']],
  ])('accepts %j', (input, segments) => {
    expect(parseRelativePath(input)).toEqual(segments);
  });

  it.each([
    ['../x', 'parent_segment'],
    ['src/../../x', 'parent_segment'],
    ['src\\..\\..\\x', 'parent_segment'],
    ['..', 'parent_segment'],
    ['/etc/passwd', 'absolute'],
    ['\\Windows', 'absolute'],
    ['\\\\server\\share', 'absolute'],
    ['C:\\Windows', 'drive_letter'],
    ['c:x', 'drive_letter'],
    ['file.txt:stream', 'colon'],
    ['a\u0000b', 'control_chars'],
    ['a\nb', 'control_chars'],
    ['CON', 'reserved_name'],
    ['src/nul.txt', 'reserved_name'],
    ['COM1', 'reserved_name'],
    ['src/LPT9.log', 'reserved_name'],
    ['secret.', 'trailing_dot_or_space'],
    ['dir /x', 'trailing_dot_or_space'],
    ['a'.repeat(2000), 'too_long'],
  ])('rejects %j (%s)', (input, why) => {
    expect(reason(() => parseRelativePath(input))).toBe(`PATH_OUTSIDE_PROJECT:${why}`);
  });

  it.each([null, 1, {}, ['a']])('rejects non-string %j', (input) => {
    expect(reason(() => parseRelativePath(input))).toBe('PATH_OUTSIDE_PROJECT:not_a_string');
  });
});

describe('resolveInProject', () => {
  let sb: Sandbox;
  let root: string;
  let outside: string;
  beforeEach(() => {
    sb = createSandbox();
    root = sb.project('repo');
    outside = sb.project('secret');
    makeFile(path.join(root, 'src', 'a.ts'));
    makeFile(path.join(outside, 'id_rsa'), 'PRIVATE');
  });
  afterEach(() => {
    sb.cleanup();
  });

  it('resolves existing files and directories', () => {
    expect(resolveInProject(root, 'src/a.ts')).toEqual({
      absolute: path.join(root, 'src', 'a.ts'),
      relative: 'src/a.ts',
      exists: true,
    });
    expect(resolveInProject(root, '')).toEqual({ absolute: root, relative: '', exists: true });
  });

  it('resolves paths that do not exist yet under an existing ancestor', () => {
    expect(resolveInProject(root, 'src/new/b.ts')).toEqual({
      absolute: path.join(root, 'src', 'new', 'b.ts'),
      relative: 'src/new/b.ts',
      exists: false,
    });
  });

  it('rejects traversal before touching the filesystem', () => {
    expect(reason(() => resolveInProject(root, '../secret/id_rsa'))).toBe(
      'PATH_OUTSIDE_PROJECT:parent_segment',
    );
  });

  it('rejects a linked directory inside the project that points outside it', () => {
    linkDir(outside, path.join(root, 'escape'));
    expect(reason(() => resolveInProject(root, 'escape/id_rsa'))).toBe(
      'PATH_OUTSIDE_PROJECT:symlink_escape',
    );
    expect(reason(() => resolveInProject(root, 'escape'))).toBe(
      'PATH_OUTSIDE_PROJECT:symlink_escape',
    );
  });

  it('rejects a not-yet-existing path below a link that points outside (write redirection)', () => {
    linkDir(outside, path.join(root, 'escape'));
    expect(reason(() => resolveInProject(root, 'escape/new/file.txt'))).toBe(
      'PATH_OUTSIDE_PROJECT:symlink_escape',
    );
  });

  it('allows a link that stays inside the project and reports the real location', () => {
    linkDir(path.join(root, 'src'), path.join(root, 'alias'));
    expect(resolveInProject(root, 'alias/a.ts')).toMatchObject({
      absolute: path.join(root, 'src', 'a.ts'),
      relative: 'src/a.ts',
    });
  });

  it('rejects a dangling link, whose target cannot be proven safe', () => {
    const target = makeDir(sb.work, 'gone');
    linkDir(target, path.join(root, 'dangling'));
    rmSync(target, { recursive: true, force: true }); // the link stays and now dangles
    expect(reason(() => resolveInProject(root, 'dangling/x'))).toBe(
      'PATH_OUTSIDE_PROJECT:dangling_symlink',
    );
  });

  it('rejects a file symlink that points outside (where the OS allows creating one)', ({
    skip,
  }) => {
    if (!tryLinkFile(path.join(outside, 'id_rsa'), path.join(root, 'key'))) {
      skip('file symlinks need extra privileges on this OS');
    }
    expect(reason(() => resolveInProject(root, 'key'))).toBe('PATH_OUTSIDE_PROJECT:symlink_escape');
  });
});

describe('isWithin and pathKey', () => {
  it('handles prefixes that are not path boundaries', () => {
    expect(isWithin('/a/b', '/a/b/c', 'linux')).toBe(true);
    expect(isWithin('/a/b', '/a/b', 'linux')).toBe(true);
    expect(isWithin('/a/b', '/a/bc', 'linux')).toBe(false);
    expect(isWithin('/a/b', '/a', 'linux')).toBe(false);
    expect(isWithin('/a/b', '/a/b/../c', 'linux')).toBe(false);
  });

  it('is case-insensitive and drive-aware on Windows', () => {
    expect(isWithin('C:\\Repo', 'c:\\repo\\src', 'win32')).toBe(true);
    expect(isWithin('C:\\Repo', 'D:\\Repo\\src', 'win32')).toBe(false);
    expect(isWithin('C:\\Repo', 'C:\\Repo2', 'win32')).toBe(false);
    expect(pathKey('C:\\Repo', 'win32')).toBe('c:\\repo');
    expect(pathKey('/Repo', 'linux')).toBe('/Repo');
  });
});
