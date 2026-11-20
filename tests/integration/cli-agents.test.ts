import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openApp } from '../../src/app.js';
import { runCli } from '../../src/cli/run.js';
import { createSandbox, makeDir, type Sandbox } from '../helpers/fs.js';
import { installMockCli, mockEnv } from '../helpers/mock-cli.js';

/**
 * End to end through the CLI with the real built-in definitions. The mock CLI is installed
 * under the name `claude` and answers `auth status --json` in Claude Code's format, so no real
 * coding CLI or account is involved.
 */
describe('uab agents', () => {
  let sb: Sandbox;
  let env: Record<string, string>;
  beforeEach(() => {
    sb = createSandbox();
    const bin = installMockCli(makeDir(sb.root, 'bin'), 'claude');
    env = { ...mockEnv(bin, 'ok'), UAB_HOME: sb.dataDir };
  });
  afterEach(() => {
    sb.cleanup();
  });

  async function uab(...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      argv,
      { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
      { env, homedir: sb.home },
    );
    return { code, out: out.join(''), err: err.join('') };
  }

  it('agents status shows each agent, and install guidance for missing ones', async () => {
    const r = await uab('agents', 'status');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Claude Code\s+Authenticated \(oauth\)\s+1\.2\.3-beta\.1/);
    expect(r.out).toMatch(/Kiro CLI\s+Not installed/);
    expect(r.out).toMatch(/Codex CLI\s+Not installed/);
    expect(r.out).toContain('npm install -g @openai/codex');
    expect(r.out).not.toContain('sk-fake-secret-value');
    expect(r.out).not.toContain('someone@example.com');
  });

  it('agents status --json for one agent', async () => {
    const r = await uab('agents', 'status', 'claude', '--json');
    const [status] = JSON.parse(r.out) as [
      { agentId: string; state: string; auth: { method: string } },
    ];
    expect(status).toMatchObject({ agentId: 'claude', state: 'ready', auth: { method: 'oauth' } });
  });

  it('reports a logged-out agent with login instructions', async () => {
    // Claude's environment allowlist does not pass MOCK_CLI_SCENARIO through, so the scenario
    // is fixed in the installed launcher instead.
    installMockCli(makeDir(sb.root, 'bin-logged-out'), 'claude', 'logged-out');
    env.PATH = [path.join(sb.root, 'bin-logged-out'), path.dirname(process.execPath)].join(
      path.delimiter,
    );
    const r = await uab('agents', 'status', 'claude');
    expect(r.out).toMatch(/Claude Code\s+Not authenticated/);
    expect(r.out).toContain('claude auth login');
    expect(r.out).toContain('UAB never asks for your credentials');
  });

  it('agents list states that task execution is not available yet', async () => {
    const r = await uab('agents', 'list');
    expect(r.out).toMatch(/^kiro\s+Kiro CLI/m);
    expect(r.out).toContain('not yet (planned)');
  });

  it('unknown agent id', async () => {
    const r = await uab('agents', 'status', 'skynet');
    expect(r.code).toBe(1);
    expect(r.err).toContain('AGENT_NOT_FOUND');
  });

  it('honours agents.<id>.enabled = false, including for new sessions', async () => {
    writeFileSync(
      path.join(sb.dataDir, 'config.json'),
      JSON.stringify({ agents: { codex: { enabled: false } } }),
    );
    expect((await uab('agents', 'status', 'codex')).out).toMatch(/Codex CLI\s+Disabled/);

    const dir = sb.project('repo');
    await uab('project', 'add', dir);
    const created = await uab('session', 'create', '--project', dir, '--agent', 'codex');
    expect(created.code).toBe(1);
    expect(created.err).toContain('AGENT_NOT_FOUND');
    expect((await uab('session', 'create', '--project', dir, '--agent', 'claude')).code).toBe(0);
  });

  it('rejects configuration for unknown agents before opening the database', async () => {
    writeFileSync(
      path.join(sb.dataDir, 'config.json'),
      JSON.stringify({ agents: { gemini: { enabled: true } } }),
    );
    const r = await uab('agents', 'status');
    expect(r.code).toBe(1);
    expect(r.err).toContain('CONFIG_INVALID');
    expect(r.err).toContain('agents.gemini');
  });

  it('rejects misspelt agent settings', async () => {
    writeFileSync(
      path.join(sb.dataDir, 'config.json'),
      JSON.stringify({ agents: { kiro: { enable: false } } }),
    );
    expect((await uab('agents', 'list')).err).toContain('CONFIG_INVALID');
  });

  it('the app wires the registry into session agent validation', async () => {
    const app = await openApp({ env, homedir: sb.home });
    try {
      expect(app.agents.ids()).toEqual(['kiro', 'claude', 'opencode', 'codex']);
    } finally {
      app.close();
    }
  });
});
