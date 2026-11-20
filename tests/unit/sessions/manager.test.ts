import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '../../../src/projects/registry.js';
import { SESSION_ID_PATTERN, SESSION_TOKEN_PATTERN } from '../../../src/sessions/types.js';
import { createServices, type Services } from '../../helpers/services.js';

describe('SessionManager', () => {
  let s: Services;
  let project: Project;
  beforeEach(() => {
    s = createServices();
    project = s.projects.register(s.sandbox.project('tfalke'), 'TFALKE').project;
  });
  afterEach(() => {
    s.close();
  });

  const create = (agentId = 'kiro', extra: Record<string, unknown> = {}) =>
    s.sessions().create({ project: project.id, agentId, ...extra });
  const ref = (c: ReturnType<typeof create>) => ({
    sessionId: c.session.sessionId,
    sessionToken: c.sessionToken,
  });

  describe('create', () => {
    it('creates a session bound to the project and agent, and returns a token once', () => {
      const c = create('kiro', { title: 'AI Assistant Phase 3' });
      expect(c.session.sessionId).toMatch(SESSION_ID_PATTERN);
      expect(c.sessionToken).toMatch(SESSION_TOKEN_PATTERN);
      expect(c.session).toMatchObject({
        status: 'active',
        agentId: 'kiro',
        title: 'AI Assistant Phase 3',
        projectName: 'TFALKE',
        project: { id: project.id, path: project.path },
        agents: [{ agentId: 'kiro', hasNativeSession: false }],
        otherActiveSessionsOnProject: 0,
      });
      expect(c.warnings).toEqual([]);
      expect(JSON.stringify(c.session)).not.toContain(c.sessionToken);
    });

    it('accepts the project directory path as well as the project id', () => {
      expect(
        s.sessions().create({ project: project.path, agentId: 'claude' }).session.project.id,
      ).toBe(project.id);
    });

    it('stores only a hash of the token', () => {
      const c = create();
      const row = s.db.get<{ token_hash: string }>(
        'SELECT token_hash FROM sessions WHERE id = ?',
        c.session.sessionId,
      );
      expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
      const everything =
        JSON.stringify(s.db.all('SELECT * FROM sessions')) +
        JSON.stringify(s.db.all('SELECT * FROM session_events'));
      expect(everything).not.toContain(c.sessionToken);
    });

    it('gives every session a different id and token', () => {
      const a = create();
      const b = create();
      expect(a.session.sessionId).not.toBe(b.session.sessionId);
      expect(a.sessionToken).not.toBe(b.sessionToken);
    });

    it('warns when another active session uses the same directory', () => {
      create('kiro');
      const second = create('claude');
      expect(second.session.otherActiveSessionsOnProject).toBe(1);
      expect(second.warnings[0]).toMatch(/same working tree/);
    });

    it('never infers the project: it is required', () => {
      expect(() => s.sessions().create({ agentId: 'kiro' })).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      );
    });

    it('rejects unknown agents and malformed agent ids', () => {
      expect(() => create('gpt-pilot')).toThrow(
        expect.objectContaining({ code: 'AGENT_NOT_FOUND' }),
      );
      expect(() => create('Kiro; rm -rf /')).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      );
    });

    it('rejects unknown input fields', () => {
      expect(() => create('kiro', { sessionId: 'UAB-CHOSEN' })).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      );
    });

    it('does not let ChatGPT register new directories by default', () => {
      const unregistered = s.sandbox.project('unregistered');
      expect(() => s.sessions('mcp').create({ project: unregistered, agentId: 'kiro' })).toThrow(
        expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }),
      );
      expect(s.projects.list()).toHaveLength(1);
    });

    it('lets ChatGPT register a directory only when enabled, still applying the path policy', () => {
      const mcp = s.sessions('mcp', { allowMcpRegistration: true });
      const dir = s.sandbox.project('new-one');
      expect(mcp.create({ project: dir, agentId: 'kiro' }).session.project.path).toBe(dir);
      expect(() => mcp.create({ project: s.sandbox.home, agentId: 'kiro' })).toThrow(
        expect.objectContaining({ code: 'PROJECT_PATH_INVALID' }),
      );
    });

    it('the CLI actor never auto-registers', () => {
      const cli = s.sessions('cli', { allowMcpRegistration: true });
      expect(() => cli.create({ project: s.sandbox.project('x'), agentId: 'kiro' })).toThrow(
        expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }),
      );
    });
  });

  describe('list', () => {
    it('returns metadata only, newest first, and hides closed sessions by default', () => {
      const a = create('kiro');
      s.clock.advance(1000);
      const b = create('claude');
      s.sessions().close(ref(a));

      const active = s.sessions().list();
      expect(active.map((x) => x.sessionId)).toEqual([b.session.sessionId]);
      expect(Object.keys(active[0] ?? {}).sort()).toEqual(
        [
          'agentId',
          'createdAt',
          'lastUsedAt',
          'projectName',
          'sessionId',
          'status',
          'title',
        ].sort(),
      );
      expect(JSON.stringify(active)).not.toContain(project.path);

      expect(s.sessions().list({ includeClosed: true })).toHaveLength(2);
    });
  });

  describe('get and resume', () => {
    it('returns details with the right token', () => {
      const c = create();
      expect(s.sessions().get(ref(c)).sessionId).toBe(c.session.sessionId);
    });

    it('resume updates last use and records an event', () => {
      const c = create();
      s.clock.advance(60_000);
      const { session } = s.sessions().resume(ref(c));
      expect(session.lastUsedAt).toBe('2026-01-01T00:01:00.000Z');
      expect(
        s
          .sessions()
          .history(ref(c))
          .events.map((e) => e.type),
      ).toEqual(['created', 'resumed']);
    });

    it('cannot resume a closed session', () => {
      const c = create();
      s.sessions().close(ref(c));
      expect(() => s.sessions().resume(ref(c))).toThrow(
        expect.objectContaining({ code: 'SESSION_CLOSED' }),
      );
    });
  });

  describe('close', () => {
    it('closes once and is idempotent', () => {
      const c = create();
      const closed = s.sessions().close(ref(c));
      expect(closed).toMatchObject({ status: 'closed', closedAt: '2026-01-01T00:00:00.000Z' });
      s.sessions().close(ref(c));
      expect(
        s
          .sessions()
          .history(ref(c))
          .events.filter((e) => e.type === 'closed'),
      ).toHaveLength(1);
    });

    it('a closed session can still be read with its token', () => {
      const c = create();
      s.sessions().close(ref(c));
      expect(s.sessions().get(ref(c)).status).toBe('closed');
    });
  });

  describe('switchAgent', () => {
    it('switches the current agent and keeps a separate slot per agent', () => {
      const c = create('kiro');
      s.clock.advance(1000);
      const { session, changed } = s.sessions().switchAgent(ref(c), 'claude');
      expect(changed).toBe(true);
      expect(session.agentId).toBe('claude');
      expect(session.agents.map((a) => a.agentId)).toEqual(['kiro', 'claude']);
      expect(session.agents.every((a) => !a.hasNativeSession)).toBe(true);
      expect(s.sessions().history(ref(c)).events.at(-1)).toMatchObject({
        type: 'agent_switched',
        data: { from: 'kiro', to: 'claude' },
      });
    });

    it('switching back reuses the earlier agent slot, and switching to the same agent is a no-op', () => {
      const c = create('kiro');
      s.clock.advance(1000);
      s.sessions().switchAgent(ref(c), 'claude');
      s.clock.advance(1000);
      s.sessions().switchAgent(ref(c), 'kiro');
      const { session, changed } = s.sessions().switchAgent(ref(c), 'kiro');
      expect(changed).toBe(false);
      expect(session.agents.map((a) => a.agentId)).toEqual(['kiro', 'claude']);
    });

    it('rejects unknown agents and closed sessions', () => {
      const c = create('kiro');
      expect(() => s.sessions().switchAgent(ref(c), 'nope')).toThrow(
        expect.objectContaining({ code: 'AGENT_NOT_FOUND' }),
      );
      s.sessions().close(ref(c));
      expect(() => s.sessions().switchAgent(ref(c), 'claude')).toThrow(
        expect.objectContaining({ code: 'SESSION_CLOSED' }),
      );
    });
  });

  describe('history', () => {
    it('pages with a cursor', () => {
      const c = create('kiro');
      for (const agent of ['claude', 'opencode', 'codex', 'kiro'])
        s.sessions().switchAgent(ref(c), agent);
      const first = s.sessions().history(ref(c), { limit: 2 });
      expect(first.events).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = s.sessions().history(ref(c), { limit: 2, cursor: first.nextCursor });
      const third = s.sessions().history(ref(c), { limit: 2, cursor: second.nextCursor });
      expect(third.nextCursor).toBeNull();
      expect([...first.events, ...second.events, ...third.events].map((e) => e.type)).toEqual([
        'created',
        'agent_switched',
        'agent_switched',
        'agent_switched',
        'agent_switched',
      ]);
    });

    it('validates paging input', () => {
      const c = create();
      for (const query of [
        { limit: 0 },
        { limit: 1000 },
        { cursor: '-1' },
        { cursor: 'abc' },
        { extra: 1 },
      ]) {
        expect(() => s.sessions().history(ref(c), query)).toThrow(
          expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
        );
      }
    });
  });
});

describe('SessionAdmin', () => {
  let s: Services;
  let project: Project;
  beforeEach(() => {
    s = createServices();
    project = s.projects.register(s.sandbox.project('app')).project;
  });
  afterEach(() => {
    s.close();
  });

  it('rotates the token: the old token stops working, the new one works', () => {
    const c = s.sessions().create({ project: project.id, agentId: 'opencode' });
    const oldRef = { sessionId: c.session.sessionId, sessionToken: c.sessionToken };
    const { sessionToken } = s.admin.rotateToken(c.session.sessionId);

    expect(sessionToken).not.toBe(c.sessionToken);
    expect(() => s.sessions().get(oldRef)).toThrow(
      expect.objectContaining({ code: 'SESSION_NOT_FOUND' }),
    );
    expect(s.sessions().get({ sessionId: c.session.sessionId, sessionToken }).agentId).toBe(
      'opencode',
    );
    expect(s.admin.history(c.session.sessionId).events.at(-1)?.type).toBe('token_rotated');
  });

  it('lists, shows and closes sessions by id, case-insensitively', () => {
    const c = s.sessions().create({ project: project.id, agentId: 'kiro' });
    expect(s.admin.list().map((x) => x.sessionId)).toEqual([c.session.sessionId]);
    expect(s.admin.get(c.session.sessionId.toLowerCase()).project.path).toBe(project.path);
    expect(s.admin.close(c.session.sessionId).status).toBe('closed');
    expect(s.admin.list()).toEqual([]);
    expect(s.admin.list({ includeClosed: true })).toHaveLength(1);
  });

  it('reports unknown or malformed ids as SESSION_NOT_FOUND', () => {
    for (const id of ['UAB-000000000000', 'nope', "UAB-' OR 1=1 --"]) {
      expect(() => s.admin.get(id)).toThrow(expect.objectContaining({ code: 'SESSION_NOT_FOUND' }));
    }
  });
});
