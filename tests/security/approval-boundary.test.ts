import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { mockAgentDefinition } from '../helpers/mock-cli.js';

/** End-to-end attacks against the approval and execution boundary. */
describe('approval and execution boundary', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  it('an approval for one session cannot be used by another session for its own task', async () => {
    t = await createTestApp();
    const a = t.session();
    const b = t.session();
    const ta = t.app.tasks.propose('mcp', a.ctx, {
      kind: 'implement',
      title: 'a',
      prompt: 'same prompt',
    });
    const tb = t.app.tasks.propose('mcp', b.ctx, {
      kind: 'implement',
      title: 'b',
      prompt: 'same prompt',
    });
    t.approve(ta.taskId);
    expect(() => t?.app.executions.dispatch('mcp', b.ctx, tb.taskId)).toThrow(
      expect.objectContaining({ code: 'APPROVAL_REQUIRED' }),
    );
    expect(() => t?.app.executions.dispatch('mcp', b.ctx, ta.taskId)).toThrow(
      expect.objectContaining({ code: 'TASK_NOT_FOUND' }),
    );
  });

  it('switching agent after approval invalidates dispatch of the old task for the wrong agent', async () => {
    t = await createTestApp();
    const a = t.session();
    const task = t.app.tasks.propose('mcp', a.ctx, { kind: 'implement', title: 'a', prompt: 'p' });
    t.approve(task.taskId);
    // Tampering: the task row is pointed at another agent after approval.
    t.app.db.run("UPDATE tasks SET agent_id = 'other' WHERE id = ?", task.taskId);
    expect(() => t?.app.executions.dispatch('mcp', a.ctx, task.taskId)).toThrow();
    expect(t.app.executions.activeCount).toBe(0);
  });

  it('a closed session cannot propose or dispatch', async () => {
    t = await createTestApp();
    const s = t.session();
    const task = t.app.tasks.propose('mcp', s.ctx, { kind: 'implement', title: 'a', prompt: 'p' });
    t.approve(task.taskId);
    t.app.sessions('mcp').close(s.ref);
    const ctx = t.app.sessions('mcp').authenticate(s.ref);
    expect(() => t?.app.executions.dispatch('mcp', ctx, task.taskId)).toThrow(
      expect.objectContaining({ code: 'SESSION_CLOSED' }),
    );
    expect(() =>
      t?.app.tasks.propose('mcp', ctx, { kind: 'fix', title: 'x', prompt: 'y' }),
    ).toThrow(expect.objectContaining({ code: 'SESSION_CLOSED' }));
  });

  it('shell metacharacters in the test command are passed as plain arguments', async () => {
    t = await createTestApp();
    const project = t.app.projects.findByPath(t.projectDir);
    if (project === undefined) throw new Error('project');
    const marker = path.join(t.projectDir, 'pwned.txt');
    t.app.projects.setTestCommand(project.id, [
      process.execPath,
      '-e',
      'process.exit(0)',
      '&&',
      'echo',
      'x',
      '>',
      marker,
      ';',
      'touch',
      marker,
    ]);
    const s = t.session();
    const task = t.app.tasks.propose('mcp', s.ctx, { kind: 'implement', title: 'a', prompt: 'p' });
    t.approve(task.taskId);
    const info = t.app.executions.dispatch('mcp', s.ctx, task.taskId);
    await t.app.executions.wait(info.executionId);
    expect(t.app.executions.result(s.ctx, task.taskId)?.verification.status).toBe('passed');
    expect(existsSync(marker)).toBe(false);
  });

  it('a prompt containing shell syntax reaches the agent verbatim and runs nothing else', async () => {
    t = await createTestApp();
    const s = t.session();
    const marker = path.join(t.projectDir, 'injected.txt');
    const prompt = `"; echo hacked > "${marker}" & rem $(touch ${marker}) \`touch ${marker}\``;
    const task = t.app.tasks.propose('mcp', s.ctx, { kind: 'implement', title: 'a', prompt });
    t.approve(task.taskId);
    const info = t.app.executions.dispatch('mcp', s.ctx, task.taskId);
    await t.app.executions.wait(info.executionId);
    expect(existsSync(marker)).toBe(false);
    expect(t.app.tasks.get(null, task.taskId).status).toBe('succeeded');
  });

  it('the CLI refuses to approve a task that already ran or was rejected', async () => {
    t = await createTestApp();
    const s = t.session();
    const task = t.app.tasks.propose('mcp', s.ctx, { kind: 'implement', title: 'a', prompt: 'p' });
    t.app.tasks.reject('cli', null, task.taskId);
    const out: string[] = [];
    const code = await runCli(
      ['approve', task.taskId, '--sha256', task.promptSha256, '--yes'],
      { stdout: (x) => out.push(x), stderr: (x) => out.push(x) },
      {
        env: t.env,
        homedir: t.sb.home,
        agentDefinitions: [mockAgentDefinition()],
      },
    );
    expect(code).toBe(1);
    expect(out.join('')).toContain('TASK_STATE_INVALID');
  });
});
