import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '../../src/projects/registry.js';
import { createServices, type Services } from '../helpers/services.js';

/**
 * Cross-session access prevention and session id manipulation.
 * Models two ChatGPT conversations (A and B) that each hold only their own credentials.
 */
describe('session isolation', () => {
  let s: Services;
  let project: Project;
  let a: { sessionId: string; sessionToken: string };
  let b: { sessionId: string; sessionToken: string };

  beforeEach(() => {
    s = createServices();
    project = s.projects.register(s.sandbox.project('shared-repo')).project;
    const ca = s
      .sessions()
      .create({ project: project.id, agentId: 'kiro', title: 'Conversation A' });
    const cb = s
      .sessions()
      .create({ project: project.id, agentId: 'claude', title: 'Conversation B' });
    a = { sessionId: ca.session.sessionId, sessionToken: ca.sessionToken };
    b = { sessionId: cb.session.sessionId, sessionToken: cb.sessionToken };
  });
  afterEach(() => {
    s.close();
  });

  const operations = (ref: unknown) => [
    () => s.sessions().get(ref),
    () => s.sessions().resume(ref),
    () => s.sessions().history(ref),
    () => s.sessions().switchAgent(ref, 'opencode'),
    () => s.sessions().close(ref),
  ];

  const notFound: unknown = expect.objectContaining({
    code: 'SESSION_NOT_FOUND',
    message: 'Session not found or token invalid.',
  });

  it("conversation B cannot use A's session id with B's own token", () => {
    for (const op of operations({ sessionId: a.sessionId, sessionToken: b.sessionToken })) {
      expect(op).toThrow(notFound);
    }
  });

  it('a session id without its token is useless', () => {
    for (const ref of [
      { sessionId: a.sessionId },
      { sessionId: a.sessionId, sessionToken: '' },
      { sessionId: a.sessionId, sessionToken: 'uab_st_' + 'A'.repeat(43) },
      { sessionId: a.sessionId, sessionToken: a.sessionToken.slice(0, -1) },
      { sessionId: a.sessionId, sessionToken: a.sessionToken + 'x' },
      { sessionId: a.sessionId, sessionToken: a.sessionToken.toUpperCase() },
    ]) {
      for (const op of operations(ref)) expect(op).toThrow(notFound);
    }
  });

  it('unknown, malformed and injected session ids return the same error as a wrong token', () => {
    for (const sessionId of [
      'UAB-000000000000',
      a.sessionId.toLowerCase(),
      ` ${a.sessionId}`,
      "UAB-' OR '1'='1",
      '%',
      '*',
      'x'.repeat(10_000),
    ]) {
      for (const op of operations({ sessionId, sessionToken: a.sessionToken })) {
        expect(op).toThrow(notFound);
      }
    }
  });

  it.each([null, undefined, 'UAB-x', 42, [], { sessionId: 1, sessionToken: 2 }, { extra: true }])(
    'malformed credentials (%j) return SESSION_NOT_FOUND, not a validation error',
    (ref) => {
      for (const op of operations(ref)) expect(op).toThrow(notFound);
    },
  );

  it('failed attempts leave the other session untouched', () => {
    for (const op of operations({ sessionId: a.sessionId, sessionToken: b.sessionToken })) {
      try {
        op();
      } catch {
        // expected
      }
    }
    const sessionA = s.sessions().get(a);
    expect(sessionA).toMatchObject({ status: 'active', agentId: 'kiro' });
    expect(
      s
        .sessions()
        .history(a)
        .events.map((e) => e.type),
    ).toEqual(['created']);
  });

  it("B's history never contains A's events, and switching agents in A does not affect B", () => {
    s.sessions().switchAgent(a, 'codex');
    s.sessions().close(a);
    expect(
      s
        .sessions()
        .history(b)
        .events.map((e) => e.type),
    ).toEqual(['created']);
    expect(s.sessions().get(b)).toMatchObject({ status: 'active', agentId: 'claude' });
    expect(
      s
        .sessions()
        .get(b)
        .agents.map((x) => x.agentId),
    ).toEqual(['claude']);
  });

  it('list_sessions exposes no tokens, token hashes, paths or history', () => {
    const listed = JSON.stringify(s.sessions().list({ includeClosed: true }));
    expect(listed).not.toContain(a.sessionToken);
    expect(listed).not.toContain(b.sessionToken);
    expect(listed).not.toMatch(/[0-9a-f]{64}/);
    expect(listed).not.toContain(project.path);
    expect(listed).not.toMatch(/"type"|"events"|"data"/);
  });

  it('a new session never inherits an existing session on the same project', () => {
    const c = s.sessions().create({ project: project.id, agentId: 'kiro' });
    const ref = { sessionId: c.session.sessionId, sessionToken: c.sessionToken };
    expect(
      s
        .sessions()
        .history(ref)
        .events.map((e) => e.type),
    ).toEqual(['created']);
    expect(c.session.agents.map((x) => x.agentId)).toEqual(['kiro']);
    expect(c.session.agents.every((x) => !x.hasNativeSession)).toBe(true);
  });

  it('a closed session cannot be revived by a conversation, only read', () => {
    s.sessions().close(a);
    expect(() => s.sessions().resume(a)).toThrow(
      expect.objectContaining({ code: 'SESSION_CLOSED' }),
    );
    expect(() => s.sessions().switchAgent(a, 'claude')).toThrow(
      expect.objectContaining({ code: 'SESSION_CLOSED' }),
    );
  });
});
