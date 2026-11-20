import { randomUUID } from 'node:crypto';
import { ErrorCode, UabError } from '../core/errors.js';
import { randomId, type RandomBytes } from '../core/ids.js';
import type { Logger } from '../core/logger.js';
import type { Database } from '../database/index.js';
import { assertSafeArgs } from '../agents/args.js';
import type { AgentRegistry } from '../agents/registry.js';
import { resolveExecutable } from '../agents/resolve.js';
import type { AgentEvent, TaskMode } from '../agents/types.js';
import { buildChildEnv } from './env.js';
import { runProcess, type RunRequest, type RunResult } from './process.js';
import { Git, type GitSnapshot } from '../results/git.js';
import { parseTestSummary, type TestSummary } from '../results/tests.js';
import { pathKey } from '../security/paths.js';
import type { Redactor } from '../security/redact.js';
import type { SessionContext, TaskDetails, TaskService } from '../tasks/service.js';
import type { Actor } from '../sessions/types.js';

export type ExecutionStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'permission_denied'
  | 'timed_out'
  | 'cancelled'
  | 'interrupted';

export interface ChangedFile {
  readonly path: string;
  readonly change: 'modified' | 'created' | 'deleted' | 'renamed' | 'other';
  /** The file already had uncommitted changes before the task started. */
  readonly preExisting: boolean;
}

export interface VerificationResult {
  readonly status: 'passed' | 'failed' | 'timed_out' | 'error' | 'not_configured' | 'skipped';
  readonly command: readonly string[] | null;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly summary: TestSummary | null;
  /** Last part of the (redacted) output. */
  readonly outputTail: string | null;
  readonly reason?: string;
}

export interface TaskResult {
  readonly executionId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly mode: TaskMode;
  readonly status: ExecutionStatus;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  /** What the agent said about its own success. Not verified by UAB. */
  readonly agentReportedSuccess: boolean | null;
  /** The agent's final message (redacted, untrusted content). */
  readonly finalMessage: string;
  readonly permissionDenials: { readonly count: number; readonly tools: readonly string[] };
  readonly errors: readonly string[];
  readonly toolCalls: number;
  readonly git: {
    readonly isRepo: boolean;
    readonly branch: string | null;
    readonly headBefore: string | null;
    readonly headAfter: string | null;
    readonly commitsCreated: number;
    readonly changedFiles: readonly ChangedFile[];
    readonly diffStat: string;
  };
  /** UAB's own check: the project's verification command, run by UAB after the agent. */
  readonly verification: VerificationResult;
  readonly outputTruncated: boolean;
  /** A write task held the working tree while this read-only task ran. */
  readonly concurrentWriter: boolean;
  readonly warnings: readonly string[];
  readonly setupHint: string | null;
}

export interface ExecutionInfo {
  readonly executionId: string;
  readonly taskId: string;
  readonly status: ExecutionStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly cancelRequested: boolean;
}

interface ExecutionRow {
  id: string;
  task_id: string;
  approval_id: string;
  session_id: string;
  agent_id: string;
  mode: TaskMode;
  status: ExecutionStatus;
  owner_pid: number;
  cancel_requested: number;
  started_at: string;
  heartbeat_at: string;
  ended_at: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  error: string | null;
}

export interface ExecutionManagerDeps {
  readonly db: Database;
  readonly tasks: TaskService;
  readonly agents: AgentRegistry;
  readonly redactor: Redactor;
  readonly timeoutMs: number;
  readonly verifyTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly git?: Git;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly randomBytes?: RandomBytes;
  readonly run?: (req: RunRequest) => Promise<RunResult>;
  readonly pid?: number;
  readonly heartbeatMs?: number;
}

const MAX_LINE_CHARS = 16 * 1024;
const MAX_FINAL_CHARS = 20_000;
const STALE_HEARTBEAT_MS = 120_000;

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Splits a byte stream into lines without breaking multi-byte characters. */
class LineSplitter {
  #rest = '';
  readonly #decoder = new TextDecoder('utf-8');
  constructor(private readonly onLine: (line: string) => void) {}
  push(chunk: Buffer): void {
    const text = this.#rest + this.#decoder.decode(chunk, { stream: true });
    const lines = text.split(/\r?\n/);
    this.#rest = lines.pop() ?? '';
    for (const line of lines) this.onLine(line);
  }
  end(): void {
    const tail = this.#rest + this.#decoder.decode();
    this.#rest = '';
    if (tail !== '') this.onLine(tail);
  }
}

/**
 * Starts approved tasks and supervises them. Dispatch consumes the approval and creates the
 * execution in one transaction; the agent then runs in the background of this process.
 */
export class ExecutionManager {
  readonly #db: Database;
  readonly #tasks: TaskService;
  readonly #agents: AgentRegistry;
  readonly #redactor: Redactor;
  readonly #git: Git;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #now: () => Date;
  readonly #random: RandomBytes | undefined;
  readonly #run: (req: RunRequest) => Promise<RunResult>;
  readonly #pid: number;
  readonly #deps: ExecutionManagerDeps;
  readonly #running = new Map<string, { controller: AbortController; done: Promise<void> }>();

  constructor(deps: ExecutionManagerDeps) {
    this.#deps = deps;
    this.#db = deps.db;
    this.#tasks = deps.tasks;
    this.#agents = deps.agents;
    this.#redactor = deps.redactor;
    this.#env = deps.env ?? process.env;
    this.#git = deps.git ?? new Git(this.#env);
    this.#now = deps.now ?? (() => new Date());
    this.#random = deps.randomBytes;
    this.#run = deps.run ?? runProcess;
    this.#pid = deps.pid ?? process.pid;
  }

  #ts(): string {
    return this.#now().toISOString();
  }

  #row(executionId: string): ExecutionRow | undefined {
    return this.#db.get<ExecutionRow>('SELECT * FROM executions WHERE id = ?', executionId);
  }

  #info(row: ExecutionRow): ExecutionInfo {
    return {
      executionId: row.id,
      taskId: row.task_id,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMs: row.duration_ms,
      cancelRequested: row.cancel_requested === 1,
    };
  }

  /**
   * Marks executions whose owning UAB process is gone (or silent) as interrupted. They are never
   * restarted automatically. Returns the number recovered.
   */
  recover(): number {
    const now = this.#now().getTime();
    const rows = this.#db.all<ExecutionRow>("SELECT * FROM executions WHERE status = 'running'");
    let count = 0;
    for (const row of rows) {
      if (this.#running.has(row.id)) continue;
      const stale = now - Date.parse(row.heartbeat_at) > STALE_HEARTBEAT_MS;
      if (row.owner_pid !== this.#pid && isProcessAlive(row.owner_pid) && !stale) continue;
      this.#db.transaction(() => {
        const ts = this.#ts();
        this.#db.run(
          "UPDATE executions SET status = 'interrupted', ended_at = ?, error = ? WHERE id = ? AND status = 'running'",
          ts,
          'The UAB process that ran this task stopped before it finished.',
          row.id,
        );
        this.#db.run('DELETE FROM worktree_locks WHERE execution_id = ?', row.id);
        this.#tasks.finish(
          row.task_id,
          'interrupted',
          'UAB stopped while the agent was running. The task was not restarted.',
        );
        this.#tasks.audit('system', 'execution_interrupted', row.session_id, row.task_id, {
          executionId: row.id,
        });
      });
      count++;
    }
    return count;
  }

  /** Lock holder for a project directory, if a write task is running there. */
  #activeLock(key: string): string | undefined {
    const lock = this.#db.get<{ execution_id: string; owner_pid: number }>(
      'SELECT execution_id, owner_pid FROM worktree_locks WHERE path_key = ?',
      key,
    );
    if (lock === undefined) return undefined;
    const exec = this.#row(lock.execution_id);
    const alive =
      exec?.status === 'running' &&
      (lock.owner_pid === this.#pid
        ? this.#running.has(lock.execution_id)
        : isProcessAlive(lock.owner_pid));
    if (alive) return lock.execution_id;
    this.#db.run('DELETE FROM worktree_locks WHERE path_key = ?', key);
    return undefined;
  }

  /**
   * Starts an approved task. Returns as soon as the agent process is launched; poll the task
   * status for completion. Throws if the approval is missing, used, expired or does not match.
   */
  dispatch(actor: Actor, session: SessionContext, taskId: unknown): ExecutionInfo {
    this.recover();
    // Validate the agent before consuming the approval, so setup problems do not burn it.
    const preview = this.#tasks.get(session, taskId);
    const def = this.#agents.definition(preview.agentId);
    if (def.execution === undefined) {
      throw new UabError(
        ErrorCode.AGENT_EXECUTION_UNSUPPORTED,
        `${def.displayName} cannot run tasks through UAB yet.`,
      );
    }
    const program = this.#agents.resolveProgram(preview.agentId);
    assertSafeArgs(
      def.id,
      def.execution.buildInvocation({
        prompt: preview.prompt,
        cwd: preview.projectPath,
        mode: preview.mode,
        nativeSessionId: null,
        newSessionId: randomUUID(),
        settings: this.#agents.settings(preview.agentId),
      }).args,
      def.forbiddenArgs,
    );

    const executionId = randomId('EXE-', 12, this.#random);
    const { task, concurrentWriter } = this.#db.transaction(() => {
      const claimed = this.#tasks.claimForDispatch(session, taskId);
      const key = pathKey(claimed.task.projectPath);
      const holder = this.#activeLock(key);
      const mode = claimed.task.mode;
      if (mode === 'workspace_write' && holder !== undefined) {
        throw new UabError(
          ErrorCode.WORKTREE_BUSY,
          'Another task is changing this project directory. Wait for it to finish or cancel it.',
          { details: { executionId: holder } },
        );
      }
      const ts = this.#ts();
      this.#db.run(
        `INSERT INTO executions (id, task_id, approval_id, session_id, agent_id, mode, status, owner_pid,
                                 cancel_requested, started_at, heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, 0, ?, ?)`,
        executionId,
        claimed.task.taskId,
        claimed.approvalId,
        claimed.task.sessionId,
        claimed.task.agentId,
        mode,
        this.#pid,
        ts,
        ts,
      );
      if (mode === 'workspace_write') {
        this.#db.run(
          'INSERT INTO worktree_locks (path_key, execution_id, owner_pid, acquired_at) VALUES (?, ?, ?, ?)',
          key,
          executionId,
          this.#pid,
          ts,
        );
      }
      this.#tasks.audit(actor, 'task_dispatched', claimed.task.sessionId, claimed.task.taskId, {
        executionId,
        approvalId: claimed.approvalId,
        agentId: claimed.task.agentId,
        promptSha256: claimed.task.promptSha256,
      });
      return { task: claimed.task, concurrentWriter: mode === 'read_only' && holder !== undefined };
    });

    const controller = new AbortController();
    const done = this.#execute(executionId, task, program, controller.signal, concurrentWriter)
      .catch((error: unknown) => {
        this.#deps.logger?.error('execution crashed', {
          executionId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.#finalize(
          executionId,
          task,
          'failed',
          null,
          'UAB failed while supervising the agent.',
        );
      })
      .finally(() => {
        this.#running.delete(executionId);
      });
    this.#running.set(executionId, { controller, done });
    const row = this.#row(executionId);
    if (row === undefined) throw new Error('Execution row missing.');
    return this.#info(row);
  }

  async #execute(
    executionId: string,
    task: TaskDetails,
    program: { command: string; prefixArgs: readonly string[] },
    signal: AbortSignal,
    concurrentWriter: boolean,
  ): Promise<void> {
    const def = this.#agents.definition(task.agentId);
    const execution = def.execution;
    if (execution === undefined) throw new Error('No execution adapter.');
    const startedAt = Date.parse(this.#row(executionId)?.started_at ?? this.#ts());

    const before = await this.#git.snapshot(task.projectPath);
    const nativeRow = this.#db.get<{ native_session_id: string | null }>(
      'SELECT native_session_id FROM session_agents WHERE session_id = ? AND agent_id = ?',
      task.sessionId,
      task.agentId,
    );
    const invocation = execution.buildInvocation({
      prompt: task.prompt,
      cwd: task.projectPath,
      mode: task.mode,
      nativeSessionId: task.freshAgentSession ? null : (nativeRow?.native_session_id ?? null),
      newSessionId: randomUUID(),
      settings: this.#agents.settings(task.agentId),
    });
    assertSafeArgs(def.id, invocation.args, def.forbiddenArgs);

    // Output storage: redacted lines, capped in total.
    let seq = 0;
    let storedBytes = 0;
    let truncated = false;
    const store = (stream: 'stdout' | 'stderr' | 'uab', line: string) => {
      if (truncated) return;
      const text = this.#redactor.redact(
        line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} […line truncated]` : line,
      );
      if (storedBytes + text.length > this.#deps.maxOutputBytes) {
        truncated = true;
        this.#db.run(
          'INSERT INTO execution_output VALUES (?, ?, ?, ?, ?)',
          executionId,
          ++seq,
          'uab',
          this.#ts(),
          '[output limit reached; further output was not stored]',
        );
        return;
      }
      storedBytes += text.length;
      this.#db.run(
        'INSERT INTO execution_output VALUES (?, ?, ?, ?, ?)',
        executionId,
        ++seq,
        stream,
        this.#ts(),
        text,
      );
    };

    const events: AgentEvent[] = [];
    const stdout = new LineSplitter((line) => {
      if (line.trim() === '') return;
      store('stdout', line);
      try {
        const parsed = execution.parseStdoutLine(line);
        events.push(...parsed);
        // Stop at once on a fatal error (for example rejected credentials) instead of
        // waiting for the CLI's own retries.
        if (parsed.some((e) => e.type === 'error' && e.fatal === true) && !state.fatal) {
          state.fatal = true;
          setTimeout(() => {
            controller.abort();
          }, 1500).unref();
        }
      } catch {
        // Unparseable agent output is kept in the log and otherwise ignored.
      }
    });
    const stderr = new LineSplitter((line) => {
      if (line.trim() === '') return;
      store('stderr', line);
      try {
        events.push(...(execution.parseStderrLine?.(line) ?? []));
      } catch {
        // ignored
      }
    });

    const controller = new AbortController();
    const forward = () => {
      controller.abort();
    };
    signal.addEventListener('abort', forward, { once: true });
    if (signal.aborted) controller.abort();
    const state = { cancelled: false, fatal: false };
    const heartbeat = setInterval(() => {
      this.#db.run('UPDATE executions SET heartbeat_at = ? WHERE id = ?', this.#ts(), executionId);
      const row = this.#db.get<{ cancel_requested: number }>(
        'SELECT cancel_requested FROM executions WHERE id = ?',
        executionId,
      );
      if (row?.cancel_requested === 1) {
        state.cancelled = true;
        controller.abort();
      }
    }, this.#deps.heartbeatMs ?? 2000);
    heartbeat.unref();

    store('uab', `Starting ${def.displayName} (${task.mode}) in the project directory.`);
    let result: RunResult;
    try {
      result = await this.#run({
        command: program.command,
        args: [...program.prefixArgs, ...invocation.args],
        cwd: task.projectPath,
        env: this.#agents.childEnv(task.agentId),
        stdin: invocation.stdin,
        timeoutMs: this.#deps.timeoutMs,
        maxOutputBytes: 64 * 1024,
        signal: controller.signal,
        onStdout: (c) => {
          stdout.push(c);
        },
        onStderr: (c) => {
          stderr.push(c);
        },
      });
    } finally {
      clearInterval(heartbeat);
      signal.removeEventListener('abort', forward);
    }
    stdout.end();
    stderr.end();
    if (result.outcome === 'aborted' && !state.cancelled) {
      state.cancelled =
        this.#db.get<{ c: number }>(
          'SELECT cancel_requested AS c FROM executions WHERE id = ?',
          executionId,
        )?.c === 1;
    }

    // Summarise agent events.
    const nativeSessionId =
      events.find((e): e is Extract<AgentEvent, { type: 'session' }> => e.type === 'session')
        ?.nativeSessionId ??
      invocation.nativeSessionId ??
      null;
    const finals = events.filter(
      (e): e is Extract<AgentEvent, { type: 'final' }> => e.type === 'final',
    );
    const final = finals.at(-1);
    const finalText =
      final?.text !== undefined && final.text !== ''
        ? final.text
        : events
            .filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text')
            .map((e) => e.text)
            .join('');
    const denials = events.filter(
      (e): e is Extract<AgentEvent, { type: 'permission_denied' }> =>
        e.type === 'permission_denied',
    );
    const errorEvents = events.filter(
      (e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error',
    );
    const fatal = errorEvents.some((e) => e.fatal === true);

    let status: ExecutionStatus;
    let note: string | null = null;
    if (state.cancelled) {
      status = 'cancelled';
      note = 'Cancelled while running.';
    } else if (result.outcome === 'timed_out') {
      status = 'timed_out';
      note = `The agent did not finish within ${String(Math.round(this.#deps.timeoutMs / 60000))} minutes.`;
    } else if (result.outcome === 'spawn_failed') {
      status = 'failed';
      note = `The agent could not be started (${result.spawnError ?? 'unknown error'}).`;
    } else if (result.outcome === 'aborted' && state.fatal) {
      status = 'failed';
      note = 'The agent reported a fatal error and was stopped.';
    } else if (result.outcome === 'aborted') {
      status = 'interrupted';
      note = 'UAB stopped while the agent was running.';
    } else if (result.exitCode !== 0 || fatal || final?.success === false) {
      status = denials.length > 0 ? 'permission_denied' : 'failed';
    } else {
      status = 'succeeded';
    }

    const after = await this.#git.snapshot(task.projectPath);
    const changedFiles = this.#changedFiles(before, after);
    const commitsCreated = before.isRepo
      ? await this.#git.commitsBetween(task.projectPath, before.head, after.head)
      : 0;
    const diffStat =
      after.isRepo && changedFiles.length > 0
        ? this.#redactor.redact(await this.#git.diffStat(task.projectPath))
        : '';

    const verification = await this.#verify(task, status);

    const warnings: string[] = [];
    if (commitsCreated > 0)
      warnings.push(
        `The agent created ${String(commitsCreated)} commit(s). UAB tasks are not supposed to commit; review them.`,
      );
    if (denials.length > 0 && status === 'succeeded')
      warnings.push('The agent was denied some actions but reported success; check the result.');
    if (task.mode === 'read_only' && changedFiles.some((f) => !f.preExisting))
      warnings.push('Files changed during a read-only task.');
    if (!execution.verified)
      warnings.push(
        `The ${def.displayName} integration has not been verified against a real installation.`,
      );
    if (concurrentWriter)
      warnings.push('A write task was running in the same directory at the same time.');

    const setupProblem = status === 'failed' || status === 'permission_denied';
    const taskResult: TaskResult = {
      executionId,
      taskId: task.taskId,
      sessionId: task.sessionId,
      agentId: task.agentId,
      mode: task.mode,
      status,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: this.#ts(),
      durationMs: this.#now().getTime() - startedAt,
      exitCode: result.exitCode,
      agentReportedSuccess: final?.success ?? null,
      finalMessage: this.#redactor.redact(finalText).slice(0, MAX_FINAL_CHARS),
      permissionDenials: { count: denials.length, tools: [...new Set(denials.map((d) => d.tool))] },
      errors: [
        ...new Set(errorEvents.map((e) => this.#redactor.redact(e.message).slice(0, 500))),
      ].slice(0, 10),
      toolCalls: events.filter(
        (e) => e.type === 'tool' && e.status !== 'completed' && e.status !== 'failed',
      ).length,
      git: {
        isRepo: after.isRepo,
        branch: after.branch,
        headBefore: before.head,
        headAfter: after.head,
        commitsCreated,
        changedFiles,
        diffStat,
      },
      verification,
      outputTruncated: truncated,
      concurrentWriter,
      warnings,
      setupHint: setupProblem ? (execution.setupHint ?? null) : null,
    };

    this.#db.transaction(() => {
      this.#db.run(
        'INSERT OR REPLACE INTO execution_results (execution_id, data) VALUES (?, ?)',
        executionId,
        JSON.stringify(taskResult),
      );
      if (nativeSessionId !== null) {
        this.#db.run(
          'UPDATE session_agents SET native_session_id = ?, last_used_at = ? WHERE session_id = ? AND agent_id = ?',
          nativeSessionId,
          this.#ts(),
          task.sessionId,
          task.agentId,
        );
      }
      this.#db.run(
        'UPDATE executions SET exit_code = ? WHERE id = ?',
        result.exitCode,
        executionId,
      );
    });
    this.#finalize(executionId, task, status, result.exitCode, note);
  }

  #changedFiles(before: GitSnapshot, after: GitSnapshot): ChangedFile[] {
    const prior = new Map(before.files.map((f) => [f.path, f.code]));
    const files: ChangedFile[] = after.files.map((f) => ({
      path: f.path,
      change: f.change,
      preExisting: prior.get(f.path) === f.code,
    }));
    // Files that were dirty before and are clean now (for example reverted by the agent).
    for (const f of before.files) {
      if (!after.files.some((a) => a.path === f.path))
        files.push({ path: f.path, change: 'other', preExisting: true });
    }
    return files;
  }

  async #verify(task: TaskDetails, status: ExecutionStatus): Promise<VerificationResult> {
    const command = task.verifyCommand;
    const empty = { command, exitCode: null, durationMs: null, summary: null, outputTail: null };
    if (command === null || command.length === 0) return { status: 'not_configured', ...empty };
    if (status === 'cancelled' || status === 'timed_out' || status === 'interrupted') {
      return { status: 'skipped', ...empty, reason: 'The agent did not finish.' };
    }
    const [name, ...args] = command;
    const resolved = resolveExecutable([name ?? ''], {
      env: this.#env,
      ...(name !== undefined && /[\\/]/.test(name) ? { override: name } : {}),
    });
    if (!resolved.ok)
      return { status: 'error', ...empty, reason: `Cannot run ${name ?? ''}: ${resolved.reason}.` };
    const r = await this.#run({
      command: resolved.executable.command,
      args: [...resolved.executable.prefixArgs, ...args],
      cwd: task.projectPath,
      env: buildChildEnv(this.#env),
      timeoutMs: this.#deps.verifyTimeoutMs,
      maxOutputBytes: 512 * 1024,
    });
    const output = `${r.stdout}\n${r.stderr}`;
    const tail = this.#redactor.redact(output.slice(-8000));
    const summary = parseTestSummary(output);
    if (r.outcome === 'timed_out')
      return {
        status: 'timed_out',
        command,
        exitCode: null,
        durationMs: r.durationMs,
        summary,
        outputTail: tail,
      };
    if (r.outcome !== 'exited')
      return {
        status: 'error',
        command,
        exitCode: null,
        durationMs: r.durationMs,
        summary: null,
        outputTail: tail,
        reason: r.spawnError ?? r.outcome,
      };
    return {
      status: r.exitCode === 0 ? 'passed' : 'failed',
      command,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      summary,
      outputTail: tail,
    };
  }

  #finalize(
    executionId: string,
    task: TaskDetails,
    status: ExecutionStatus,
    exitCode: number | null,
    note: string | null,
  ): void {
    this.#db.transaction(() => {
      const row = this.#row(executionId);
      if (row === undefined || row.status !== 'running') return;
      const ts = this.#ts();
      this.#db.run(
        'UPDATE executions SET status = ?, ended_at = ?, exit_code = ?, duration_ms = ?, error = ? WHERE id = ?',
        status,
        ts,
        exitCode,
        Date.parse(ts) - Date.parse(row.started_at),
        note,
        executionId,
      );
      this.#db.run('DELETE FROM worktree_locks WHERE execution_id = ?', executionId);
      this.#tasks.finish(task.taskId, status, note);
      this.#tasks.audit('system', 'execution_finished', task.sessionId, task.taskId, {
        executionId,
        status,
        exitCode,
      });
      this.#db.run(
        'INSERT INTO session_events (session_id, ts, actor, type, data) VALUES (?, ?, ?, ?, ?)',
        task.sessionId,
        ts,
        'system',
        'task_finished',
        JSON.stringify({ taskId: task.taskId, status }),
      );
    });
  }

  /** Cancels a running task (in any UAB process) or a task that has not started. */
  cancel(
    actor: Actor,
    session: SessionContext | null,
    taskId: unknown,
  ): { taskId: string; status: string } {
    const task = this.#tasks.get(session, taskId);
    if (task.status !== 'running') {
      const t = this.#tasks.cancelBeforeRun(actor, session, taskId);
      return { taskId: t.taskId, status: t.status };
    }
    const row = this.#db.get<ExecutionRow>(
      "SELECT * FROM executions WHERE task_id = ? AND status = 'running'",
      task.taskId,
    );
    if (row === undefined) return { taskId: task.taskId, status: task.status };
    this.#db.run('UPDATE executions SET cancel_requested = 1 WHERE id = ?', row.id);
    this.#tasks.audit(actor, 'cancel_requested', task.sessionId, task.taskId, {
      executionId: row.id,
    });
    this.#running.get(row.id)?.controller.abort();
    return { taskId: task.taskId, status: 'cancelling' };
  }

  execution(session: SessionContext | null, taskId: unknown): ExecutionInfo | null {
    const task = this.#tasks.get(session, taskId);
    const row = this.#db.get<ExecutionRow>(
      'SELECT * FROM executions WHERE task_id = ?',
      task.taskId,
    );
    return row === undefined ? null : this.#info(row);
  }

  result(session: SessionContext | null, taskId: unknown): TaskResult | null {
    const task = this.#tasks.get(session, taskId);
    const row = this.#db.get<{ data: string }>(
      'SELECT r.data FROM execution_results r JOIN executions e ON e.id = r.execution_id WHERE e.task_id = ?',
      task.taskId,
    );
    return row === undefined ? null : (JSON.parse(row.data) as TaskResult);
  }

  logs(
    session: SessionContext | null,
    taskId: unknown,
    query: {
      cursor?: number | undefined;
      limit: number;
      stream?: 'stdout' | 'stderr' | 'uab' | undefined;
      contains?: string | undefined;
      maxBytes: number;
    },
  ): {
    lines: { seq: number; stream: string; ts: string; text: string }[];
    nextCursor: number | null;
    truncated: boolean;
  } {
    const task = this.#tasks.get(session, taskId);
    const exec = this.#db.get<{ id: string }>(
      'SELECT id FROM executions WHERE task_id = ?',
      task.taskId,
    );
    if (exec === undefined) return { lines: [], nextCursor: null, truncated: false };
    const rows = this.#db.all<{ seq: number; stream: string; ts: string; chunk: string }>(
      `SELECT seq, stream, ts, chunk FROM execution_output
       WHERE execution_id = ? AND seq > ? AND (? IS NULL OR stream = ?) AND (? IS NULL OR instr(lower(chunk), lower(?)) > 0)
       ORDER BY seq LIMIT ?`,
      exec.id,
      query.cursor ?? 0,
      query.stream ?? null,
      query.stream ?? null,
      query.contains ?? null,
      query.contains ?? null,
      query.limit + 1,
    );
    const lines: { seq: number; stream: string; ts: string; text: string }[] = [];
    let bytes = 0;
    let truncated = false;
    for (const r of rows.slice(0, query.limit)) {
      if (bytes + r.chunk.length > query.maxBytes && lines.length > 0) {
        truncated = true;
        break;
      }
      bytes += r.chunk.length;
      lines.push({
        seq: r.seq,
        stream: r.stream,
        ts: r.ts,
        text: r.chunk.slice(0, query.maxBytes),
      });
    }
    const more = truncated || rows.length > query.limit;
    const last = lines.at(-1);
    return { lines, nextCursor: more && last !== undefined ? last.seq : null, truncated };
  }

  /** Waits for a run started by this process (tests and the CLI `task run`). */
  async wait(executionId: string): Promise<void> {
    await this.#running.get(executionId)?.done;
  }

  get activeCount(): number {
    return this.#running.size;
  }

  /** Stops all runs owned by this process (on shutdown) and waits for them to be recorded. */
  async shutdown(): Promise<void> {
    const runs = [...this.#running.values()];
    for (const r of runs) r.controller.abort();
    await Promise.allSettled(runs.map((r) => r.done));
  }
}
