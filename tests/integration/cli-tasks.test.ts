import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { createTestApp, waitForTask, type TestApp } from '../helpers/app.js';
import { mockAgentDefinition } from '../helpers/mock-cli.js';

describe('uab approve / reject / tasks (local user)', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  async function uab(argv: string[], answers?: string[]) {
    if (t === undefined) throw new Error('no app');
    const out: string[] = [];
    const err: string[] = [];
    const queue = answers === undefined ? undefined : [...answers];
    const code = await runCli(
      argv,
      {
        stdout: (s) => out.push(s),
        stderr: (s) => err.push(s),
        ...(queue === undefined ? {} : { readLine: () => Promise.resolve(queue.shift() ?? '') }),
      },
      { env: t.env, homedir: t.sb.home, agentDefinitions: [mockAgentDefinition()] },
    );
    return { code, out: out.join(''), err: err.join('') };
  }

  function propose(prompt = 'Implement it') {
    if (t === undefined) throw new Error('no app');
    const s = t.session();
    return {
      s,
      task: t.app.tasks.propose('mcp', s.ctx, { kind: 'implement', title: 'Phase 3', prompt }),
    };
  }

  it('shows the complete prompt and hash, and approves only after "yes"', async () => {
    t = await createTestApp();
    const { task } = propose('Line one\nLine two');
    const shown = await uab(['approve', task.taskId], ['no']);
    expect(shown.out).toContain('PENDING APPROVAL');
    expect(shown.out).toContain('Line one\nLine two');
    expect(shown.out).toContain(task.promptSha256);
    expect(shown.out).toContain('Test Repo');
    expect(shown.out).toContain('Not approved');
    expect(t.app.tasks.get(null, task.taskId).status).toBe('pending_approval');

    const approved = await uab(['approve', task.taskId], ['yes']);
    expect(approved.out).toContain(`Approved ${task.taskId}`);
    expect(t.app.tasks.get(null, task.taskId).status).toBe('approved');
  });

  it('without a terminal, approval needs --sha256 and --yes', async () => {
    t = await createTestApp();
    const { task } = propose();
    const r = await uab(['approve', task.taskId]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(`--sha256 ${task.promptSha256} --yes`);
    expect((await uab(['approve', task.taskId, '--yes'])).code).toBe(2);
    expect(
      (await uab(['approve', task.taskId, '--yes', '--sha256', 'f'.repeat(64)])).err,
    ).toContain('APPROVAL_MISMATCH');
    expect((await uab(['approve', task.taskId, '--yes', '--sha256', task.promptSha256])).code).toBe(
      0,
    );
  });

  it('an answer given after the prompt was revised does not approve the new version', async () => {
    t = await createTestApp();
    const { s, task } = propose('v1');
    const result = await runCli(
      ['approve', task.taskId],
      {
        stdout: () => undefined,
        stderr: () => undefined,
        readLine: () => {
          t?.app.tasks.revise('mcp', s.ctx, task.taskId, { prompt: 'v2: also push to production' });
          return Promise.resolve('yes');
        },
      },
      { env: t.env, homedir: t.sb.home, agentDefinitions: [mockAgentDefinition()] },
    );
    expect(result).toBe(1);
    expect(t.app.tasks.get(null, task.taskId)).toMatchObject({
      status: 'pending_approval',
      version: 2,
    });
  });

  it('reject, request-changes, pending, tasks, task show, run, result, logs, audit', async () => {
    t = await createTestApp();
    const a = propose('first');
    const b = propose('second');
    expect((await uab(['pending'])).out).toContain(a.task.taskId);
    expect((await uab(['reject', a.task.taskId, '--reason', 'out of scope'])).out).toContain(
      'It can never run',
    );
    expect((await uab(['request-changes', b.task.taskId, '--note', 'smaller please'])).code).toBe(
      0,
    );
    expect(t.app.tasks.get(null, b.task.taskId).status).toBe('changes_requested');
    expect((await uab(['pending'])).out).toContain('Nothing is waiting');

    const c = propose('third WRITE:c.txt');
    t.approve(c.task.taskId);
    const run = await uab(['task', 'run', c.task.taskId]);
    expect(run.code).toBe(0);
    expect(run.out).toContain('Result of');
    expect(run.out).toContain('succeeded');
    expect(await waitForTask(t.app, c.task.taskId)).toBe('succeeded');
    expect((await uab(['task', 'result', c.task.taskId])).out).toContain(
      'UAB verification:       not_configured',
    );
    expect((await uab(['task', 'logs', c.task.taskId])).out).toContain('[stdout]');
    expect((await uab(['task', 'show', c.task.taskId])).out).toContain('TASK (succeeded)');
    expect((await uab(['tasks'])).out).toContain(c.task.taskId);
    const audit = (await uab(['audit'])).out;
    for (const action of [
      'task_proposed',
      'task_rejected',
      'changes_requested',
      'task_approved',
      'task_dispatched',
      'execution_finished',
    ]) {
      expect(audit).toContain(action);
    }
    expect((await uab(['approve', 'nonsense'])).code).toBe(2);
  });

  it('project set-test / clear-test, mcp-config and agents setup kiro', async () => {
    t = await createTestApp();
    const set = await uab(['project', 'set-test', t.projectDir, '--', 'npm', 'test']);
    expect(set.out).toContain('npm test');
    expect((await uab(['project', 'list'])).out).toContain('verifies with: npm test');
    const { task } = propose();
    expect(t.app.tasks.get(null, task.taskId).verifyCommand).toEqual(['npm', 'test']);
    expect((await uab(['project', 'clear-test', t.projectDir])).code).toBe(0);

    const cfg = await uab(['mcp-config']);
    expect(cfg.out).toContain('[mcp_servers.uab]');
    expect(cfg.out).toContain('.codex');
    expect((await uab(['mcp-config', '--uab-home', 'relative'])).code).toBe(2);

    const setup = await uab(['agents', 'setup', 'kiro']);
    expect(setup.out).toContain('uab-write');
    expect((await uab(['agents', 'setup', 'claude'])).code).toBe(2);
  });
});
