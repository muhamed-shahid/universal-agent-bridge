import { spawn } from 'node:child_process';
import path from 'node:path';
import { ErrorCode, UabError } from '../core/errors.js';

export interface RunRequest {
  /** Absolute path of a real executable. Never a shell, a .cmd/.bat file or a bare name. */
  readonly command: string;
  readonly args: readonly string[];
  /** Absolute working directory. */
  readonly cwd: string;
  /** Complete child environment (see buildChildEnv). Nothing else is inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs: number;
  /** Per-stream byte cap. Extra output is discarded and `truncated` is set. */
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  /** Called with every chunk as it arrives (before capping). */
  readonly onStdout?: (chunk: Buffer) => void;
  readonly onStderr?: (chunk: Buffer) => void;
  /** Called once the process has started. */
  readonly onSpawn?: (pid: number) => void;
}

export type RunOutcome = 'exited' | 'timed_out' | 'aborted' | 'spawn_failed';

export interface RunResult {
  readonly outcome: RunOutcome;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
  /** errno code when the process could not be started (ENOENT, EACCES, …). */
  readonly spawnError?: string;
}

/** Windows batch files run through cmd.exe, which re-parses arguments. Never spawn them. */
const SHELL_SCRIPT = /\.(cmd|bat|ps1|vbs|js|wsf)$/i;

export function assertSpawnable(req: Pick<RunRequest, 'command' | 'args' | 'cwd'>): void {
  const fail = (reason: string) =>
    new UabError(ErrorCode.INVALID_ARGUMENT, 'Refusing to start process.', { details: { reason } });
  if (!path.isAbsolute(req.command)) throw fail('command_not_absolute');
  if (process.platform === 'win32' && SHELL_SCRIPT.test(req.command)) throw fail('shell_script');
  if (!path.isAbsolute(req.cwd)) throw fail('cwd_not_absolute');
  for (const value of [req.command, req.cwd, ...req.args]) {
    if (value.includes('\u0000')) throw fail('nul_byte');
  }
}

class Capture {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  truncated = false;
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    const room = this.limit - this.#bytes;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (part.length < chunk.length) this.truncated = true;
    this.#chunks.push(part);
    this.#bytes += part.length;
  }
  text(): string {
    return Buffer.concat(this.#chunks).toString('utf8');
  }
}

/** Kills the process and its children. */
function killTree(
  pid: number | undefined,
  child: { kill(signal?: NodeJS.Signals): boolean },
): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    // taskkill is a real executable; arguments are an array, no shell involved.
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const killer = spawn(
      path.join(systemRoot, 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'],
      {
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    killer.on('error', () => child.kill('SIGKILL'));
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL'); // whole process group (child was started detached)
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * Runs a process with no shell, a fixed environment, a timeout that kills the whole process
 * tree, and capped output. Never throws for process failures; inspect `outcome`. Rejects
 * (with INVALID_ARGUMENT) only for requests that are unsafe to start at all.
 */
export function runProcess(req: RunRequest): Promise<RunResult> {
  try {
    assertSpawnable(req);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  const started = Date.now();
  const out = new Capture(req.maxOutputBytes);
  const err = new Capture(req.maxOutputBytes);

  return new Promise((resolve) => {
    let outcome: RunOutcome = 'exited';
    let settled = false;
    const child = spawn(req.command, [...req.args], {
      cwd: req.cwd,
      env: { ...req.env },
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      spawnError?: string,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      resolve({
        outcome,
        exitCode,
        signal,
        stdout: out.text(),
        stderr: err.text(),
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        durationMs: Date.now() - started,
        ...(spawnError === undefined ? {} : { spawnError }),
      });
    };

    const stop = (why: RunOutcome) => {
      if (settled || outcome !== 'exited') return;
      outcome = why;
      killTree(child.pid, child);
    };
    const onAbort = () => {
      stop('aborted');
    };
    const timer = setTimeout(() => {
      stop('timed_out');
    }, req.timeoutMs);
    timer.unref();

    if (req.signal?.aborted === true) {
      queueMicrotask(onAbort);
    } else {
      req.signal?.addEventListener('abort', onAbort, { once: true });
    }

    child.on('spawn', () => {
      if (child.pid !== undefined) req.onSpawn?.(child.pid);
    });
    child.stdout.on('data', (c: Buffer) => {
      out.push(c);
      req.onStdout?.(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      err.push(c);
      req.onStderr?.(c);
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      outcome = 'spawn_failed';
      finish(null, null, e.code ?? 'UNKNOWN');
    });
    child.on('close', (code, signal) => {
      finish(code, signal);
    });

    child.stdin.on('error', () => {
      // The child may exit without reading stdin (EPIPE). Not an error for the caller.
    });
    child.stdin.end(req.stdin ?? '');
  });
}
