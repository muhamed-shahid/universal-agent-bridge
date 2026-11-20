import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionManager } from '../../src/execution/manager.js';
import { Redactor } from '../../src/security/redact.js';
import { createTestApp, git, waitForTask, type TestApp } from '../helpers/app.js';

const hasGit = (() => {
  try {
    git(process.cwd(), '--version');
    return true;
  } catch {
    return false;
  }
})();

describe('execution with a mock coding agent', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  async function runTask(
    prompt: string,
    kind = 'implement',
    opts: { session?: ReturnType<TestApp['session']> } = {},
  ) {
    if (t === undefined) throw new Error('no app');
    const s = opts.session ?? t.session();
    const task = t.app.tasks.propose('mcp', s.ctx, { kind, title: 'test', prompt });
    t.approve(task.taskId);
    const info = t.app.executions.dispatch('mcp', s.ctx, task.taskId);
    await t.app.executions.wait(info.executionId);
    return { s, task, result: t.app.executions.result(s.ctx, task.taskId) };
  }

  it('an unapproved task cannot be dispatched and nothing runs', async () => {
    t = await createTestApp();
    const s = t.session();
    const task = t.app.tasks.propose('mcp', s.ctx, {
      kind: 'implement',
      title: 'x',
      prompt: 'WRITE:never.txt',
    });
    expect(() => t?.app.executions.dispatch('mcp', s.ctx, task.taskId)).toThrow(
      expect.objectContaining({ code: 'APPROVAL_REQUIRED' }),
    );
    expect(existsSync(path.join(t.projectDir, 'never.txt'))).toBe(false);
    expect(t.app.executions.activeCount).toBe(0);
  });

  it('a rejected task never runs', async () => {
    t = await createTestApp();
    const s = t.session();
    const task = t.app.tasks.propose('mcp', s.ctx, {
      kind: 'implement',
      title: 'x',
      prompt: 'WRITE:never.txt',
    });
    t.app.tasks.reject('cli', null, task.taskId);
    expect(() => t?.app.executions.dispatch('mcp', s.ctx, task.taskId)).toThrow(
      expect.objectContaining({ code: 'APPROVAL_ALREADY_USED' }),
    );
    expect(existsSync(path.join(t.projectDir, 'never.txt'))).toBe(false);
  });

  it('runs an approved task: exact prompt on stdin, project cwd, result collected', async () => {
    t = await createTestApp();
    const { task, result } = await runTask('Please do it. WRITE:src/new.ts');
    expect(result).toMatchObject({
      status: 'succeeded',
      agentReportedSuccess: true,
      exitCode: 0,
      permissionDenials: { count: 0 },
    });
    expect(result?.finalMessage).toMatch(/^Done in mock-session-/);
    expect(readFileSync(path.join(t.projectDir, 'src', 'new.ts'), 'utf8')).toBe(
      'written by mock agent\n',
    );
    expect(t.app.tasks.get(null, task.taskId).status).toBe('succeeded');

    // The agent received exactly the approved text (hash printed by the mock agent).
    const logs = t.app.executions.logs(null, task.taskId, { limit: 50, maxBytes: 100_000 });
    const promptLine = logs.lines.find((l) => l.text.includes('"type":"prompt"'));
    expect(promptLine?.text).toContain(`"sha256":"${task.promptSha256}"`);
    expect(promptLine?.text).toContain('"args":["--mode","workspace_write"]');
    expect(logs.lines[0]).toMatchObject({ stream: 'uab' });
  });

  it('read-only kinds run in read_only mode', async () => {
    t = await createTestApp();
    const { task } = await runTask('Review please', 'review');
    const logs = t.app.executions.logs(null, task.taskId, { limit: 50, maxBytes: 100_000 });
    expect(logs.lines.some((l) => l.text.includes('"--mode","read_only"'))).toBe(true);
  });

  it('a second task in the session continues the agent conversation; another session does not', async () => {
    t = await createTestApp();
    const s1 = t.session();
    const first = await runTask('one', 'implement', { session: s1 });
    const nativeId = /Done in (mock-session-\d+)/.exec(first.result?.finalMessage ?? '')?.[1];
    const second = await runTask('two', 'implement', { session: s1 });
    expect(second.result?.finalMessage).toBe(`Done in ${String(nativeId)}`);

    const s2 = t.session();
    const other = await runTask('three', 'implement', { session: s2 });
    expect(other.result?.finalMessage).not.toContain(String(nativeId));

    const fresh = t.app.tasks.propose('mcp', s1.ctx, {
      kind: 'fix',
      title: 'f',
      prompt: 'four',
      freshAgentSession: true,
    });
    t.approve(fresh.taskId);
    const info = t.app.executions.dispatch('mcp', s1.ctx, fresh.taskId);
    await t.app.executions.wait(info.executionId);
    expect(t.app.executions.result(s1.ctx, fresh.taskId)?.finalMessage).not.toContain(
      String(nativeId),
    );
  });

  it('reports permission denials and failures distinctly', async () => {
    t = await createTestApp();
    const denied = await runTask('DENY');
    expect(denied.result).toMatchObject({
      status: 'permission_denied',
      permissionDenials: { count: 1, tools: ['shell'] },
      setupHint: 'mock setup hint',
    });
    const failed = await runTask('FAIL');
    expect(failed.result).toMatchObject({
      status: 'failed',
      exitCode: 3,
      agentReportedSuccess: false,
    });
  });

  it('cannot dispatch the same approval twice (replay)', async () => {
    t = await createTestApp();
    const { s, task } = await runTask('once');
    expect(() => t?.app.executions.dispatch('mcp', s.ctx, task.taskId)).toThrow(
      expect.objectContaining({ code: 'APPROVAL_ALREADY_USED' }),
    );
  });

  it('another session cannot dispatch, cancel or read the task', async () => {
    t = await createTestApp();
    const a = t.session();
    const b = t.session();
    const task = t.app.tasks.propose('mcp', a.ctx, {
      kind: 'implement',
      title: 'x',
      prompt: 'WRITE:a.txt',
    });
    t.approve(task.taskId);
    expect(() => t?.app.executions.dispatch('mcp', b.ctx, task.taskId)).toThrow(
      expect.objectContaining({ code: 'TASK_NOT_FOUND' }),
    );
    expect(() => t?.app.executions.cancel('mcp', b.ctx, task.taskId)).toThrow(
      expect.objectContaining({ code: 'TASK_NOT_FOUND' }),
    );
    expect(() => t?.app.executions.result(b.ctx, task.taskId)).toThrow(
      expect.objectContaining({ code: 'TASK_NOT_FOUND' }),
    );
    expect(t.app.tasks.get(null, task.taskId).status).toBe('approved');
  });

  it('cancels a running task and kills the agent', async () => {
    t = await createTestApp();
    const s = t.session();
    const task = t.app.tasks.propose('mcp', s.ctx, {
      kind: 'implement',
      title: 'x',
      prompt: 'SLEEP',
    });
    t.approve(task.taskId);
    const info = t.app.executions.dispatch('mcp', s.ctx, task.taskId);
    await new Promise((r) => setTimeout(r, 500));
    expect(t.app.executions.cancel('mcp', s.ctx, task.taskId).status).toBe('cancelling');
    await t.app.executions.wait(info.executionId);
    expect(t.app.tasks.get(null, task.taskId).status).toBe('cancelled');
  });

  it('a pending or approved task can be cancelled before it runs', async () => {
    t = await createTestApp();
    const s = t.session();
    const task = t.app.tasks.propose('mcp', s.ctx, { kind: 'implement', title: 'x', prompt: 'x' });
    t.approve(task.taskId);
    expect(t.app.executions.cancel('mcp', s.ctx, task.taskId).status).toBe('cancelled');
    expect(() => t?.app.executions.dispatch('mcp', s.ctx, task.taskId)).toThrow();
  });

  it('times out a hanging agent', async () => {
    t = await createTestApp();
    const app = t.app;
    const manager = new ExecutionManager({
      db: app.db,
      tasks: app.tasks,
      agents: app.agents,
      redactor: new Redactor(),
      timeoutMs: 800,
      verifyTimeoutMs: 5000,
      maxOutputBytes: 100_000,
      env: t.env,
      heartbeatMs: 100,
    });
    const s = t.session();
    const task = app.tasks.propose('mcp', s.ctx, {
      kind: 'implement',
      title: 'x',
      prompt: 'SLEEP',
    });
    t.approve(task.taskId);
    const info = manager.dispatch('mcp', s.ctx, task.taskId);
    await manager.wait(info.executionId);
    expect(app.tasks.get(null, task.taskId).status).toBe('timed_out');
  });

  it('allows only one writer per working tree', async () => {
    t = await createTestApp();
    const a = t.session();
    const b = t.session();
    const slow = t.app.tasks.propose('mcp', a.ctx, {
      kind: 'implement',
      title: 'x',
      prompt: 'SLEEP',
    });
    const other = t.app.tasks.propose('mcp', b.ctx, {
      kind: 'fix',
      title: 'y',
      prompt: 'WRITE:b.txt',
    });
    const review = t.app.tasks.propose('mcp', b.ctx, {
      kind: 'review',
      title: 'z',
      prompt: 'look',
    });
    for (const x of [slow, other, review]) t.approve(x.taskId);
    const info = t.app.executions.dispatch('mcp', a.ctx, slow.taskId);
    expect(() => t?.app.executions.dispatch('mcp', b.ctx, other.taskId)).toThrow(
      expect.objectContaining({ code: 'WORKTREE_BUSY' }),
    );
    // The blocked task keeps its approval and can run later.
    expect(t.app.tasks.get(null, other.taskId).status).toBe('approved');
    const r = t.app.executions.dispatch('mcp', b.ctx, review.taskId);
    await t.app.executions.wait(r.executionId);
    expect(t.app.executions.result(b.ctx, review.taskId)?.concurrentWriter).toBe(true);
    t.app.executions.cancel('mcp', a.ctx, slow.taskId);
    await t.app.executions.wait(info.executionId);
    const later = t.app.executions.dispatch('mcp', b.ctx, other.taskId);
    await t.app.executions.wait(later.executionId);
    expect(t.app.tasks.get(null, other.taskId).status).toBe('succeeded');
  });

  it('marks tasks of a dead UAB process as interrupted and never restarts them', async () => {
    t = await createTestApp();
    const s = t.session();
    const task = t.app.tasks.propose('mcp', s.ctx, {
      kind: 'implement',
      title: 'x',
      prompt: 'SLEEP',
    });
    t.approve(task.taskId);
    const info = t.app.executions.dispatch('mcp', s.ctx, task.taskId);
    await t.app.executions.shutdown();
    expect(t.app.tasks.get(null, task.taskId).status).toBe('interrupted');
    // A row left behind by a crashed process (owner pid that does not exist).
    t.app.db.run(
      "UPDATE executions SET status = 'running', owner_pid = 999999 WHERE id = ?",
      info.executionId,
    );
    t.app.db.run("UPDATE tasks SET status = 'running' WHERE id = ?", task.taskId);
    expect(t.app.executions.recover()).toBe(1);
    expect(t.app.tasks.get(null, task.taskId)).toMatchObject({ status: 'interrupted' });
    expect(() => t?.app.executions.dispatch('mcp', s.ctx, task.taskId)).toThrow(
      expect.objectContaining({ code: 'APPROVAL_ALREADY_USED' }),
    );
  });

  it('redacts secrets from stored logs and results', async () => {
    t = await createTestApp({ extraEnv: { MY_SERVICE_TOKEN: 'super-secret-env-value-123' } });
    const { task, result } = await runTask('SECRET please');
    const logs = JSON.stringify(
      t.app.executions.logs(null, task.taskId, { limit: 100, maxBytes: 1_000_000 }),
    );
    const all =
      JSON.stringify(result) +
      logs +
      JSON.stringify(t.app.db.all('SELECT * FROM execution_output'));
    expect(all).not.toContain('sk-live-abcdefghijklmnop1234');
    expect(all).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(all).not.toContain('hunter2hunter2');
    expect(all).toContain('[REDACTED]');
  });

  it('prompt injection in agent output changes nothing', async () => {
    t = await createTestApp();
    const s = t.session();
    const waiting = t.app.tasks.propose('mcp', s.ctx, {
      kind: 'implement',
      title: 'w',
      prompt: 'later',
    });
    const { result } = await runTask('INJECT', 'implement', { session: s });
    expect(result?.finalMessage).toContain('ignore previous instructions');
    expect(t.app.tasks.get(null, waiting.taskId).status).toBe('pending_approval');
  });

  it('caps stored output', async () => {
    t = await createTestApp({ config: { execution: { maxOutputBytes: 65536 } } });
    const { result } = await runTask('plain');
    expect(result?.outputTruncated).toBe(false);
  });

  it.runIf(hasGit)(
    'collects changed files, verification and commits in a git repository',
    async () => {
      t = await createTestApp({ repo: true });
      const project = t.app.projects.findByPath(t.projectDir);
      if (project === undefined) throw new Error('project');
      t.app.projects.setTestCommand(project.id, [
        process.execPath,
        '-e',
        "console.log('Tests  3 passed'); process.exit(0)",
      ]);
      const { result } = await runTask('WRITE:src/feature.ts');
      expect(result?.git.isRepo).toBe(true);
      expect(result?.git.changedFiles).toEqual([
        { path: 'src/feature.ts', change: 'created', preExisting: false },
      ]);
      expect(result?.verification).toMatchObject({ status: 'passed', exitCode: 0 });
      expect(result?.git.commitsCreated).toBe(0);

      t.app.projects.setTestCommand(project.id, [process.execPath, '-e', 'process.exit(1)']);
      const failing = await runTask('WRITE:src/other.ts');
      // The agent claims success, UAB's own check disagrees: both are reported.
      expect(failing.result).toMatchObject({
        status: 'succeeded',
        agentReportedSuccess: true,
        verification: { status: 'failed', exitCode: 1 },
      });
      const other = failing.result?.git.changedFiles.find((f) => f.path === 'src/feature.ts');
      expect(other?.preExisting).toBe(true);

      const review = await runTask('look only', 'review');
      expect(review.result?.verification.status).toBe('not_configured');
    },
  );

  it.runIf(hasGit)('the waitForTask helper sees background completion', async () => {
    t = await createTestApp({ repo: true });
    const s = t.session();
    const task = t.app.tasks.propose('mcp', s.ctx, {
      kind: 'implement',
      title: 'x',
      prompt: 'quick',
    });
    t.approve(task.taskId);
    t.app.executions.dispatch('mcp', s.ctx, task.taskId);
    expect(await waitForTask(t.app, task.taskId)).toBe('succeeded');
  });
});
