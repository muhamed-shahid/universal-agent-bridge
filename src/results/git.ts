import { resolveExecutable, type ResolvedExecutable } from '../agents/resolve.js';
import { buildChildEnv } from '../execution/env.js';
import { runProcess, type RunResult } from '../execution/process.js';
import { isSensitivePath } from '../security/redact.js';

/**
 * Read-only Git inspection of a project directory. Every command is a fixed argument list run
 * without a shell. Git's own pager, editor, hooks and credential prompts are disabled.
 */

export interface GitFileStatus {
  readonly path: string;
  /** Two-letter porcelain status, e.g. ` M`, `??`, `D `. */
  readonly code: string;
  readonly change: 'modified' | 'created' | 'deleted' | 'renamed' | 'other';
}

export interface GitSnapshot {
  readonly isRepo: boolean;
  readonly head: string | null;
  readonly branch: string | null;
  readonly files: readonly GitFileStatus[];
}

export interface GitDiffResult {
  readonly diff: string;
  readonly truncated: boolean;
  readonly hiddenFiles: readonly string[];
}

const NOT_A_REPO: GitSnapshot = { isRepo: false, head: null, branch: null, files: [] };

function classify(code: string): GitFileStatus['change'] {
  if (code === '??' || code.includes('A')) return 'created';
  if (code.includes('D')) return 'deleted';
  if (code.includes('R')) return 'renamed';
  if (code.includes('M') || code.includes('T')) return 'modified';
  return 'other';
}

/** Parses `git status --porcelain=v1 -z`. */
export function parsePorcelain(output: string): GitFileStatus[] {
  const parts = output.split('\0');
  const files: GitFileStatus[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? '';
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code.includes('R') || code.includes('C')) i++; // next part is the original path
    files.push({ path, code, change: classify(code) });
  }
  return files;
}

export class Git {
  readonly #exe: ResolvedExecutable | undefined;
  readonly #env: Record<string, string>;

  constructor(env: Readonly<Record<string, string | undefined>> = process.env) {
    const resolved = resolveExecutable(['git'], { env });
    this.#exe = resolved.ok ? resolved.executable : undefined;
    this.#env = {
      ...buildChildEnv(env),
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      GIT_EDITOR: 'true',
      GIT_OPTIONAL_LOCKS: '0',
      GCM_INTERACTIVE: 'never',
    };
  }

  get available(): boolean {
    return this.#exe !== undefined;
  }

  async #git(
    cwd: string,
    args: readonly string[],
    maxOutputBytes = 1024 * 1024,
  ): Promise<RunResult | undefined> {
    if (this.#exe === undefined) return undefined;
    return runProcess({
      command: this.#exe.command,
      args: [
        ...this.#exe.prefixArgs,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.quotepath=false',
        '--no-pager',
        ...args,
      ],
      cwd,
      env: this.#env,
      timeoutMs: 30_000,
      maxOutputBytes,
    });
  }

  async snapshot(cwd: string): Promise<GitSnapshot> {
    const top = await this.#git(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (top?.exitCode !== 0 || top.stdout.trim() !== 'true') return NOT_A_REPO;
    const [head, branch, status] = await Promise.all([
      this.#git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']),
      this.#git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      this.#git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    ]);
    return {
      isRepo: true,
      head: head?.exitCode === 0 ? head.stdout.trim() || null : null,
      branch: branch?.exitCode === 0 ? branch.stdout.trim() || null : null,
      files: status?.exitCode === 0 ? parsePorcelain(status.stdout) : [],
    };
  }

  /** Commits created between two HEADs (0 when unknown). */
  async commitsBetween(cwd: string, from: string | null, to: string | null): Promise<number> {
    if (to === null || from === to) return 0;
    if (from === null) return 1;
    const r = await this.#git(cwd, ['rev-list', '--count', `${from}..${to}`]);
    return r?.exitCode === 0 ? Number(r.stdout.trim()) || 0 : 0;
  }

  async diffStat(cwd: string): Promise<string> {
    const r = await this.#git(cwd, ['diff', 'HEAD', '--stat', '--no-color']);
    return r?.exitCode === 0 ? r.stdout : '';
  }

  /**
   * Working-tree diff against HEAD (or the index when there is no commit yet). Sensitive files
   * are excluded and listed in `hiddenFiles`. `paths` must already be validated project paths.
   */
  async diff(
    cwd: string,
    options: { paths?: readonly string[]; maxBytes: number },
  ): Promise<GitDiffResult> {
    const snap = await this.snapshot(cwd);
    if (!snap.isRepo) return { diff: '', truncated: false, hiddenFiles: [] };
    const hiddenFiles = snap.files.map((f) => f.path).filter(isSensitivePath);
    const excludes = hiddenFiles.map((p) => `:(exclude,literal)${p}`);
    const base = snap.head === null ? ['diff', '--cached'] : ['diff', 'HEAD'];
    const pathspec =
      options.paths !== undefined && options.paths.length > 0
        ? options.paths.map((p) => `:(literal)${p}`)
        : [];
    const r = await this.#git(
      cwd,
      [
        ...base,
        '--no-color',
        '--no-ext-diff',
        '--',
        ...pathspec,
        ...(excludes.length > 0 && pathspec.length === 0 ? ['.', ...excludes] : excludes),
      ],
      options.maxBytes,
    );
    return { diff: r?.stdout ?? '', truncated: r?.stdoutTruncated === true, hiddenFiles };
  }
}
