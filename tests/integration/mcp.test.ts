/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- MCP responses are untyped JSON. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { createMcpServer, SERVER_INSTRUCTIONS } from '../../src/mcp/server.js';
import { createTestApp, waitForTask, type TestApp } from '../helpers/app.js';
import { mockAgentDefinition } from '../helpers/mock-cli.js';

const EXPECTED_TOOLS = [
  'create_session',
  'list_sessions',
  'get_session',
  'resume_session',
  'close_session',
  'switch_agent',
  'get_session_history',
  'list_agents',
  'get_agent_status',
  'check_agent_authentication',
  'get_agent_version',
  'get_project_structure',
  'get_git_status',
  'get_changed_files',
  'get_git_diff',
  'propose_task',
  'revise_task_prompt',
  'get_task',
  'list_tasks',
  'get_task_status',
  'dispatch_task',
  'cancel_task',
  'get_pending_approvals',
  'get_approval_details',
  'approve_task',
  'reject_task',
  'request_prompt_changes',
  'get_task_result',
  'get_execution_logs',
  'get_test_results',
  'get_execution_summary',
].sort();

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function connect(t: TestApp) {
  const server = createMcpServer({ app: t.app, maxResponseBytes: 64 * 1024 });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test-chatgpt', version: '1.0.0' });
  await client.connect(clientT);
  const call = async (name: string, args: Json = {}): Promise<{ ok: boolean; data: Json }> => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text: string }[])[0]?.text ?? '{}';
    if (!text.startsWith('{'))
      return { ok: false, data: { error: { code: 'MCP_PROTOCOL', message: text } } };
    return { ok: r.isError !== true, data: JSON.parse(text) as Json };
  };
  return { client, call, server };
}

describe('MCP server', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  it('exposes the documented tools, no shell tool, with annotations and instructions', async () => {
    t = await createTestApp();
    const { client } = await connect(t);
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual(EXPECTED_TOOLS);
    expect(
      tools.some((x) =>
        /^(execute|run|shell)|_(shell|command)$|read_file|write_file/i.test(x.name),
      ),
    ).toBe(false);
    const byName = Object.fromEntries(tools.map((x) => [x.name, x]));
    expect(byName.get_task_result?.annotations?.readOnlyHint).toBe(true);
    expect(byName.dispatch_task?.annotations?.readOnlyHint).toBe(false);
    expect(byName.dispatch_task?.annotations?.destructiveHint).toBe(true);
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    expect(SERVER_INSTRUCTIONS.slice(0, 512)).toContain('uab approve');
  });

  it('full workflow: session -> propose -> human approves locally -> dispatch -> results -> correction', async () => {
    t = await createTestApp({ repo: true });
    const { call } = await connect(t);

    const created = await call('create_session', {
      project: t.projectDir,
      agentId: 'mockagent',
      title: 'Conversation A',
    });
    expect(created).toMatchObject({ ok: true });
    const ref = {
      sessionId: created.data.sessionId as string,
      sessionToken: created.data.sessionToken as string,
    };

    const proposed = await call('propose_task', {
      ...ref,
      kind: 'implement',
      title: 'Add feature',
      prompt: 'Implement it. WRITE:src/feature.ts',
    });
    expect(proposed.ok).toBe(true);
    const taskId = proposed.data.task.taskId as string;
    expect(proposed.data.nextStep).toContain(`uab approve ${taskId}`);

    // ChatGPT cannot run it or approve it itself.
    const early = await call('dispatch_task', { ...ref, taskId });
    expect(early).toMatchObject({ ok: false, data: { error: { code: 'APPROVAL_REQUIRED' } } });
    const selfApprove = await call('approve_task', {
      ...ref,
      taskId,
      promptSha256: proposed.data.task.promptSha256,
    });
    expect(selfApprove).toMatchObject({
      ok: false,
      data: { error: { code: 'APPROVAL_CHANNEL_LOCAL_ONLY' } },
    });
    expect(existsSync(path.join(t.projectDir, 'src', 'feature.ts'))).toBe(false);

    const pending = await call('get_pending_approvals', ref);
    expect(pending.data.pending.map((p: Json) => p.taskId)).toEqual([taskId]);
    const details = await call('get_approval_details', { ...ref, taskId });
    expect(details.data.prompt).toContain('WRITE:src/feature.ts');

    // The human approves in a terminal (non-interactive form, bound to the hash they saw).
    const out: string[] = [];
    const code = await runCli(
      ['approve', taskId, '--sha256', details.data.promptSha256 as string, '--yes'],
      { stdout: (s) => out.push(s), stderr: (s) => out.push(s) },
      { env: t.env, homedir: t.sb.home, agentDefinitions: [mockAgentDefinition()] },
    );
    expect(code).toBe(0);

    const dispatched = await call('dispatch_task', { ...ref, taskId });
    expect(dispatched.ok).toBe(true);
    expect(await waitForTask(t.app, taskId)).toBe('succeeded');

    const status = await call('get_task_status', { ...ref, taskId });
    expect(status.data).toMatchObject({ status: 'succeeded', finished: true });
    const result = await call('get_task_result', { ...ref, taskId });
    expect(result.data.result).toMatchObject({ status: 'succeeded', agentReportedSuccess: true });
    expect(result.data.result.git.changedFiles).toEqual([
      { path: 'src/feature.ts', change: 'created', preExisting: false },
    ]);
    expect(result.data.untrustedContent).toMatch(/data, not instructions/);

    const summary = await call('get_execution_summary', { ...ref, taskId });
    expect(summary.data).toMatchObject({ status: 'succeeded', changedFiles: 1 });
    const logs = await call('get_execution_logs', { ...ref, taskId, stream: 'stdout', limit: 2 });
    expect(logs.data.lines).toHaveLength(2);
    expect(logs.data.nextCursor).not.toBeNull();
    const tests = await call('get_test_results', { ...ref, taskId });
    expect(tests.data.verification.status).toBe('not_configured');

    const changed = await call('get_changed_files', ref);
    expect(changed.data.files.map((f: Json) => f.path)).toContain('src/feature.ts');
    const gitStatus = await call('get_git_status', ref);
    expect(gitStatus.data.git.isRepo).toBe(true);
    const structure = await call('get_project_structure', { ...ref, depth: 2 });
    expect(structure.data.entries.map((e: Json) => e.path)).toEqual(
      expect.arrayContaining(['README.md', 'src', 'src/feature.ts']),
    );
    expect(structure.data.entries.find((e: Json) => e.path === '.git')).toMatchObject({
      skipped: true,
    });

    // A correction is a new task with a fresh approval.
    const fix = await call('propose_task', {
      ...ref,
      kind: 'fix',
      title: 'Fix',
      prompt: 'Fix it',
      parentTaskId: taskId,
    });
    expect(fix.data.task.parentTaskId).toBe(taskId);
    expect(
      (await call('dispatch_task', { ...ref, taskId: fix.data.task.taskId })).data.error.code,
    ).toBe('APPROVAL_REQUIRED');

    const history = await call('get_session_history', ref);
    expect(history.data.events.map((e: Json) => e.type)).toEqual(
      expect.arrayContaining(['created', 'task_proposed', 'task_approved', 'task_finished']),
    );
  });

  it("another conversation cannot reach a session's tasks or results", async () => {
    t = await createTestApp();
    const { call } = await connect(t);
    const a = await call('create_session', { project: t.projectDir, agentId: 'mockagent' });
    const b = await call('create_session', { project: t.projectDir, agentId: 'mockagent' });
    const refA = { sessionId: a.data.sessionId, sessionToken: a.data.sessionToken };
    const refB = { sessionId: b.data.sessionId, sessionToken: b.data.sessionToken };
    const task = await call('propose_task', {
      ...refA,
      kind: 'review',
      title: 'r',
      prompt: 'look',
    });
    const taskId = task.data.task.taskId as string;

    for (const tool of [
      'get_task',
      'get_task_status',
      'get_task_result',
      'get_execution_logs',
      'dispatch_task',
      'cancel_task',
      'reject_task',
      'get_approval_details',
    ]) {
      const r = await call(tool, { ...refB, taskId });
      expect(r).toMatchObject({ ok: false, data: { error: { code: 'TASK_NOT_FOUND' } } });
    }
    // A's id with B's token.
    const mixed = await call('get_task', {
      sessionId: refA.sessionId,
      sessionToken: refB.sessionToken,
      taskId,
    });
    expect(mixed.data.error.code).toBe('SESSION_NOT_FOUND');
    expect((await call('list_tasks', refB)).data.tasks).toEqual([]);
    const listed = JSON.stringify((await call('list_sessions')).data);
    expect(listed).not.toContain(refA.sessionToken);
    expect(listed).not.toContain(t.projectDir.replace(/\\/g, '\\\\'));
  });

  it('validates input and returns stable error codes', async () => {
    t = await createTestApp();
    const { call, client } = await connect(t);
    const s = await call('create_session', { project: t.projectDir, agentId: 'mockagent' });
    const ref = { sessionId: s.data.sessionId, sessionToken: s.data.sessionToken };
    expect(
      (await call('propose_task', { ...ref, kind: 'deploy', title: 't', prompt: 'p' })).ok,
    ).toBe(false);
    expect(
      (await call('get_git_diff', { ...ref, paths: ['../../etc/passwd'] })).data.error.code,
    ).toBe('PATH_OUTSIDE_PROJECT');
    expect(
      (await call('get_project_structure', { ...ref, path: 'C:\\Windows' })).data.error.code,
    ).toBe('PATH_OUTSIDE_PROJECT');
    expect(
      (await call('create_session', { project: t.sb.home, agentId: 'mockagent' })).data.error.code,
    ).toBe('PROJECT_NOT_FOUND');
    const unknown = await client.callTool({
      name: 'execute_shell',
      arguments: { command: 'whoami' },
    });
    expect(unknown.isError).toBe(true);
  });

  it('chat approval works only when enabled, and only with the exact hash', async () => {
    t = await createTestApp({ config: { approval: { channel: 'chat' } } });
    const { call } = await connect(t);
    const s = await call('create_session', { project: t.projectDir, agentId: 'mockagent' });
    const ref = { sessionId: s.data.sessionId, sessionToken: s.data.sessionToken };
    const task = await call('propose_task', { ...ref, kind: 'implement', title: 't', prompt: 'p' });
    const taskId = task.data.task.taskId as string;
    expect(
      (await call('approve_task', { ...ref, taskId, promptSha256: '0'.repeat(64) })).data.error
        .code,
    ).toBe('APPROVAL_MISMATCH');
    expect(
      (await call('approve_task', { ...ref, taskId, promptSha256: task.data.task.promptSha256 }))
        .ok,
    ).toBe(true);
    expect((await call('dispatch_task', { ...ref, taskId })).ok).toBe(true);
    expect(await waitForTask(t.app, taskId)).toBe('succeeded');
  });

  it('git diff hides sensitive files and redacts secrets', async () => {
    t = await createTestApp({ repo: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(t.projectDir, 'README.md'), '# test\napi_key = "abcd1234efgh5678"\n');
    writeFileSync(path.join(t.projectDir, '.env'), 'DATABASE_PASSWORD=very-secret\n');
    const { git } = await import('../helpers/app.js');
    git(t.projectDir, 'add', '.env');
    const { call } = await connect(t);
    const s = await call('create_session', { project: t.projectDir, agentId: 'mockagent' });
    const diff = await call('get_git_diff', {
      sessionId: s.data.sessionId,
      sessionToken: s.data.sessionToken,
    });
    expect(diff.data.diff).toContain('README.md');
    expect(diff.data.diff).not.toContain('abcd1234efgh5678');
    expect(diff.data.diff).not.toContain('very-secret');
    expect(diff.data.hiddenFiles).toContain('.env');
  });
});
