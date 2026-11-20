import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { openApp, type App, type AppOptions } from '../../src/app.js';
import type { SessionContext } from '../../src/tasks/service.js';
import { createSandbox, makeDir, type Sandbox } from './fs.js';
import { gitDir, installMockCli, mockAgentDefinition, mockEnv } from './mock-cli.js';

export interface TestApp {
  readonly app: App;
  readonly sb: Sandbox;
  readonly projectDir: string;
  readonly env: Record<string, string>;
  /** Creates a session on the project and returns its MCP credentials and context. */
  session(agentId?: string): {
    ref: { sessionId: string; sessionToken: string };
    ctx: SessionContext;
  };
  /** Approves the task's current version as the local user would. */
  approve(taskId: string): void;
  close(): Promise<void>;
}

export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** Initialises a git repository with one commit. */
export function initRepo(dir: string): void {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}

/** A real app (database file, sandboxed home) whose only agent is the mock CLI. */
export async function createTestApp(
  options: {
    config?: Record<string, unknown>;
    repo?: boolean;
    extraEnv?: Record<string, string>;
    app?: Partial<AppOptions>;
  } = {},
): Promise<TestApp> {
  const sb = createSandbox();
  const bin = installMockCli(makeDir(sb.root, 'bin'));
  const g = gitDir();
  const env: Record<string, string> = {
    ...mockEnv(bin, 'ok'),
    UAB_HOME: sb.dataDir,
    ...options.extraEnv,
  };
  if (g !== undefined) env.PATH = `${env.PATH ?? ''}${path.delimiter}${g}`;
  if (options.config !== undefined)
    writeFileSync(path.join(sb.dataDir, 'config.json'), JSON.stringify(options.config));
  const app = await openApp({
    env,
    homedir: sb.home,
    agentDefinitions: [mockAgentDefinition()],
    heartbeatMs: 100,
    ...options.app,
  });
  const projectDir = sb.project('repo');
  if (options.repo === true) initRepo(projectDir);
  app.projects.register(projectDir, 'Test Repo');
  return {
    app,
    sb,
    projectDir,
    env,
    session: (agentId = 'mockagent') => {
      const created = app.sessions('mcp').create({ project: projectDir, agentId });
      const ref = { sessionId: created.session.sessionId, sessionToken: created.sessionToken };
      return { ref, ctx: app.sessions('mcp').authenticate(ref) };
    },
    approve: (taskId) => {
      const t = app.tasks.get(null, taskId);
      app.tasks.approve('cli', null, taskId, t.promptSha256);
    },
    close: async () => {
      await app.executions.shutdown();
      app.close();
      sb.cleanup();
    },
  };
}

/** Polls until the task leaves `running` (tasks run in the background). */
export async function waitForTask(app: App, taskId: string, ms = 20_000): Promise<string> {
  const end = Date.now() + ms;
  for (;;) {
    const status = app.tasks.get(null, taskId).status;
    if (status !== 'running') return status;
    if (Date.now() > end) throw new Error(`task ${taskId} still running`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
