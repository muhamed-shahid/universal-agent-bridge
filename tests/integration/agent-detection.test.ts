import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../../src/agents/registry.js';
import { runProcess, type RunRequest } from '../../src/execution/process.js';
import { makeDir, makeTempDir, removeDir } from '../helpers/fs.js';
import { installMockCli, mockDefinition, mockEnv } from '../helpers/mock-cli.js';

/** Detection against a real child process: the mock CLI installed the way npm would. */
describe('AgentRegistry detection with a mock CLI', () => {
  let dir: string;
  let bin: string;
  beforeEach(() => {
    dir = makeTempDir('uab-agents-');
    bin = installMockCli(makeDir(dir, 'bin'));
  });
  afterEach(() => {
    removeDir(dir);
  });

  const registry = (
    scenario: string,
    options: ConstructorParameters<typeof AgentRegistry>[1] = {},
  ) =>
    new AgentRegistry([mockDefinition()], {
      env: mockEnv(bin, scenario),
      probeTimeoutMs: 3000,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      ...options,
    });

  it('reports a logged-in agent as ready with version and auth method', async () => {
    const status = await registry('ok').status('mockagent');
    expect(status).toMatchObject({
      state: 'ready',
      installed: true,
      version: '1.2.3-beta.1',
      auth: { state: 'authenticated', method: 'oauth' },
      problems: [],
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(status.executable?.source).toBe('path');
    if (process.platform === 'win32') {
      // The .cmd wrapper was unwrapped: UAB runs node.exe with the script, never cmd.exe.
      expect(status.executable?.path.toLowerCase()).toBe(process.execPath.toLowerCase());
    }
  });

  it('never copies emails, keys or other CLI output into the status', async () => {
    for (const scenario of ['ok', 'hostile-label', 'garbage', 'crash']) {
      const text = JSON.stringify(await registry(scenario).status('mockagent'));
      expect(text).not.toContain('sk-fake-secret-value');
      expect(text).not.toContain('someone@example.com');
      expect(text).not.toContain('org-123');
    }
  });

  it('reports a logged-out agent', async () => {
    expect(await registry('logged-out').status('mockagent')).toMatchObject({
      state: 'not_authenticated',
      installed: true,
    });
  });

  it.each(['garbage', 'crash'])(
    'treats unreadable auth output (%s) as unknown, not as logged in',
    async (scenario) => {
      const status = await registry(scenario).status('mockagent');
      expect(status.state).toBe('auth_unknown');
      expect(status.auth.state).toBe('unknown');
    },
  );

  it('times out a hanging probe and reports it', async () => {
    const status = await registry('auth-hang', { probeTimeoutMs: 700 }).status('mockagent');
    expect(status.state).toBe('auth_unknown');
    expect(status.problems.join()).toMatch(/did not finish/);
  });

  it('reports an unreadable version without failing detection', async () => {
    const status = await registry('version-garbage').status('mockagent');
    expect(status).toMatchObject({ state: 'ready', version: null });
    expect(status.problems).toContain('Could not read the version.');
  });

  it('reports a missing CLI with install instructions', async () => {
    const status = await new AgentRegistry([mockDefinition()], {
      env: mockEnv(makeDir(dir, 'empty'), 'ok'),
    }).status('mockagent');
    expect(status).toMatchObject({
      state: 'not_installed',
      installed: false,
      executable: null,
      instructions: { install: ['npm install -g mock-agent'] },
    });
  });

  it('skips probes for disabled agents and rejects them for sessions', async () => {
    const calls: RunRequest[] = [];
    const r = registry('ok', {
      overrides: { mockagent: { enabled: false } },
      run: (req) => {
        calls.push(req);
        return runProcess(req);
      },
    });
    expect((await r.status('mockagent')).state).toBe('disabled');
    expect(calls).toHaveLength(0);
    expect(r.isAvailable('mockagent')).toBe(false);
    expect(r.isAvailable('nope')).toBe(false);
  });

  it('uses a configured executable instead of PATH', async () => {
    const program =
      process.platform === 'win32' ? path.join(bin, 'mockagent.cmd') : path.join(bin, 'mockagent');
    const r = registry('ok', {
      env: mockEnv(makeDir(dir, 'empty2'), 'ok'),
      overrides: { mockagent: { executable: program } },
    });
    const status = await r.status('mockagent');
    expect(status.state).toBe('ready');
    expect(status.executable?.source).toBe('config');
  });

  it('runs probes outside any project, with a filtered environment and constant arguments', async () => {
    const calls: RunRequest[] = [];
    const env = {
      ...mockEnv(bin, 'ok'),
      MOCK_API_KEY: 'fake-value',
      GITHUB_TOKEN: 'should-not-pass',
    };
    await registry('ok', {
      env,
      probeCwd: dir,
      run: (req) => {
        calls.push(req);
        return runProcess(req);
      },
    }).status('mockagent');

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.cwd).toBe(dir);
      expect(call.env.MOCK_API_KEY).toBe('fake-value');
      expect(call.env.GITHUB_TOKEN).toBeUndefined();
      expect(call.stdin).toBeUndefined();
    }
    expect(calls.map((c) => c.args.slice(-3).join(' '))).toEqual(
      expect.arrayContaining([expect.stringContaining('--version'), 'auth status --json']),
    );
  });

  it('reports which declared environment variables are set, by name only', async () => {
    const status = await registry('ok', {
      env: { ...mockEnv(bin, 'ok'), MOCK_API_KEY: 'fake-value' },
    }).status('mockagent');
    expect(status.envSet).toEqual(['MOCK_CLI_SCENARIO', 'MOCK_API_KEY']);
    expect(JSON.stringify(status)).not.toContain('fake-value');
  });

  it('checks several agents in parallel', async () => {
    const r = new AgentRegistry(
      [mockDefinition(), mockDefinition({ id: 'missing', executableNames: ['not-there'] })],
      { env: mockEnv(bin, 'ok') },
    );
    expect((await r.statusAll()).map((s) => [s.agentId, s.state])).toEqual([
      ['mockagent', 'ready'],
      ['missing', 'not_installed'],
    ]);
  });
});

describe('AgentRegistry validation', () => {
  it('rejects invalid definitions', () => {
    for (const bad of [
      mockDefinition({ id: 'Bad Id' }),
      mockDefinition({ executableNames: [] }),
      mockDefinition({ executableNames: ['../evil'] }),
      mockDefinition({ envPassthrough: ['A=B'] }),
      mockDefinition({ versionProbe: { args: ['--yolo'], parse: () => undefined } }),
    ]) {
      expect(() => new AgentRegistry([bad])).toThrow(
        expect.objectContaining({ code: 'AGENT_DEFINITION_INVALID' }),
      );
    }
  });

  it('rejects duplicate ids', () => {
    expect(() => new AgentRegistry([mockDefinition(), mockDefinition()])).toThrow(
      /Duplicate agent id/,
    );
  });

  it('rejects configuration for unknown agents', () => {
    expect(
      () => new AgentRegistry([mockDefinition()], { overrides: { other: { enabled: false } } }),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('reports unknown agent ids', async () => {
    const r = new AgentRegistry([mockDefinition()]);
    expect(() => r.info('nope')).toThrow(expect.objectContaining({ code: 'AGENT_NOT_FOUND' }));
    await expect(r.status('nope')).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
  });

  it('a new agent needs only a definition (no core changes)', () => {
    const r = new AgentRegistry([
      mockDefinition(),
      mockDefinition({ id: 'another-agent', displayName: 'Another' }),
    ]);
    expect(r.list().map((a) => a.agentId)).toEqual(['mockagent', 'another-agent']);
    expect(r.isAvailable('another-agent')).toBe(true);
  });
});
