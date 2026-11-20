import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openApp } from '../../src/app.js';
import { runCli } from '../../src/cli/run.js';
import { openDatabase } from '../../src/database/index.js';
import { createSandbox, type Sandbox } from '../helpers/fs.js';

function cli(sb: Sandbox) {
  return async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      argv,
      { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
      { env: { UAB_HOME: sb.dataDir }, homedir: sb.home },
    );
    return { code, out: out.join(''), err: err.join('') };
  };
}

describe('CLI: projects and sessions against a real database file', () => {
  let sb: Sandbox;
  let uab: ReturnType<typeof cli>;
  beforeEach(() => {
    sb = createSandbox();
    uab = cli(sb);
  });
  afterEach(() => {
    sb.cleanup();
  });

  it('full workflow: register, create, show, rotate, history, close', async () => {
    const dir = sb.project('Portfolio');

    const added = await uab('project', 'add', dir, '--name', 'Personal Portfolio', '--json');
    expect(added.code).toBe(0);
    const { project } = JSON.parse(added.out) as { project: { id: string; path: string } };
    expect(project.path).toBe(dir);
    expect(existsSync(path.join(sb.dataDir, 'uab.db'))).toBe(true);

    const again = await uab('project', 'add', dir);
    expect(again.out).toContain('Already registered');

    const created = await uab(
      'session',
      'create',
      '--project',
      dir,
      '--agent',
      'opencode',
      '--title',
      'Landing page',
      '--json',
    );
    expect(created.code).toBe(0);
    const c = JSON.parse(created.out) as { session: { sessionId: string }; sessionToken: string };
    const id = c.session.sessionId;

    const shown = await uab('session', 'show', id);
    expect(shown.out).toContain('Personal Portfolio');
    expect(shown.out).toContain('opencode');
    expect(shown.out).not.toContain(c.sessionToken);

    const listed = await uab('session', 'list');
    expect(listed.out).toContain(id);
    expect(listed.out).not.toContain(c.sessionToken);

    const rotated = await uab('session', 'rotate-token', id);
    expect(rotated.code).toBe(0);
    expect(rotated.out).toMatch(/uab_st_[A-Za-z0-9_-]{43}/);
    expect(rotated.out).not.toContain(c.sessionToken);

    // The old token no longer works for a ChatGPT (MCP) caller.
    const app = await openApp({ env: { UAB_HOME: sb.dataDir }, homedir: sb.home });
    try {
      expect(() =>
        app.sessions('mcp').get({ sessionId: id, sessionToken: c.sessionToken }),
      ).toThrow(expect.objectContaining({ code: 'SESSION_NOT_FOUND' }));
    } finally {
      app.close();
    }

    const closed = await uab('session', 'close', id);
    expect(closed.code).toBe(0);
    expect((await uab('session', 'list')).out).toBe('No sessions.\n');
    expect((await uab('session', 'list', '--all')).out).toContain(id);

    const history = await uab('session', 'history', id, '--json');
    const events = (JSON.parse(history.out) as { events: { type: string; actor: string }[] })
      .events;
    expect(events.map((e) => [e.actor, e.type])).toEqual([
      ['cli', 'created'],
      ['cli', 'token_rotated'],
      ['cli', 'closed'],
    ]);

    expect((await uab('project', 'remove', project.id)).code).toBe(1);
  });

  it('prints the token once in text mode with handling guidance', async () => {
    const dir = sb.project('repo');
    await uab('project', 'add', dir);
    const created = await uab('session', 'create', '--project', dir, '--agent', 'kiro');
    expect(created.out).toMatch(/Session token \(shown once/);
    expect(created.out).toMatch(/uab_st_/);
  });

  it('reports invalid input with stable codes and exit status', async () => {
    const missing = await uab('project', 'add', path.join(sb.work, 'nope'));
    expect(missing).toMatchObject({ code: 1 });
    expect(missing.err).toContain('PROJECT_PATH_INVALID');
    expect(missing.err).toContain('reason: not_found');

    const home = await uab('project', 'add', sb.home);
    expect(home.err).toContain('reason: contains_home');

    const unregistered = await uab(
      'session',
      'create',
      '--project',
      sb.project('x'),
      '--agent',
      'kiro',
    );
    expect(unregistered.err).toContain('PROJECT_NOT_FOUND');
    expect(unregistered.err).toContain('uab project add');

    const noAgent = await uab('session', 'create', '--project', sb.project('y'));
    expect(noAgent.code).toBe(2);

    const badAgent = await uab('session', 'create', '--project', sb.work, '--agent', 'skynet');
    expect(badAgent.code).toBe(1);

    expect((await uab('session', 'show', 'UAB-000000000000')).err).toContain('SESSION_NOT_FOUND');
    expect((await uab('session', 'frobnicate')).code).toBe(2);
  });

  it('db status and backup', async () => {
    const status = await uab('db', 'status', '--json');
    expect(JSON.parse(status.out)).toMatchObject({ schemaVersion: 1, latestVersion: 1 });

    const target = path.join(sb.root, 'backup', 'uab-copy.db');
    expect((await uab('db', 'backup', target)).code).toBe(0);
    const { db, migration } = openDatabase(target);
    expect(migration.applied).toEqual([]);
    db.close();

    expect((await uab('db', 'backup', 'relative.db')).code).toBe(2);
  });
});

describe('two processes sharing one database', () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = createSandbox();
  });
  afterEach(() => {
    sb.cleanup();
  });

  it('a session created in one process is visible in another', async () => {
    const dir = sb.project('repo');
    const first = await openApp({ env: { UAB_HOME: sb.dataDir }, homedir: sb.home });
    const second = await openApp({ env: { UAB_HOME: sb.dataDir }, homedir: sb.home });
    try {
      first.projects.register(dir);
      const c = first.sessions('cli').create({ project: dir, agentId: 'claude' });
      const viaSecond = second.sessions('mcp').resume({
        sessionId: c.session.sessionId,
        sessionToken: c.sessionToken,
      });
      expect(viaSecond.session.agentId).toBe('claude');
    } finally {
      first.close();
      second.close();
    }
  });

  it('the built-in node:sqlite module loads without experimental warnings on this Node version', () => {
    const result = spawnSync(process.execPath, ['-e', "require('node:sqlite')"], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    if (Number(process.versions.node.split('.')[0]) >= 24) {
      expect(result.stderr).not.toMatch(/ExperimentalWarning/);
    }
  });
});
