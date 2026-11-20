import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaskService, effectivePrompt, sha256 } from '../../../src/tasks/service.js';
import type { SessionContext } from '../../../src/tasks/service.js';
import { createServices, type Services } from '../../helpers/services.js';

const PROMPT = 'Add input validation to the signup form and write tests.';

describe('TaskService', () => {
  let s: Services;
  let tasks: TaskService;
  let a: SessionContext;
  let b: SessionContext;

  beforeEach(() => {
    s = createServices();
    const project = s.projects.register(s.sandbox.project('app')).project;
    tasks = new TaskService({
      db: s.db,
      now: s.clock.now,
      approvalExpiryMinutes: 60,
      approvalChannel: 'local',
    });
    const mk = (agentId: string) => {
      const c = s.sessions().create({ project: project.id, agentId });
      return s
        .sessions()
        .authenticate({ sessionId: c.session.sessionId, sessionToken: c.sessionToken });
    };
    a = mk('kiro');
    b = mk('claude');
  });
  afterEach(() => {
    s.close();
  });

  const propose = (ctx = a, extra: Record<string, unknown> = {}) =>
    tasks.propose('mcp', ctx, {
      kind: 'implement',
      title: 'Signup validation',
      prompt: PROMPT,
      ...extra,
    });

  describe('propose', () => {
    it('creates a pending task bound to the session, agent and project, with the UAB rules header', () => {
      const t = propose();
      expect(t).toMatchObject({
        status: 'pending_approval',
        sessionId: a.sessionId,
        agentId: 'kiro',
        version: 1,
        mode: 'workspace_write',
      });
      expect(t.prompt).toBe(effectivePrompt(t.taskId, 'implement', PROMPT));
      expect(t.prompt).toContain('Do not run git commit, git push');
      expect(t.prompt.endsWith(PROMPT)).toBe(true);
      expect(t.promptSha256).toBe(sha256(t.prompt));
    });

    it('marks review, summarize and diagnose as read-only', () => {
      for (const kind of ['review', 'summarize', 'diagnose']) {
        const t = propose(a, { kind });
        expect(t.mode).toBe('read_only');
        expect(t.prompt).toContain('read-only task');
      }
    });

    it('rejects invalid input and closed sessions', () => {
      expect(() => propose(a, { kind: 'deploy' })).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      );
      expect(() => propose(a, { prompt: '   ' })).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      );
      expect(() => propose(a, { prompt: 'x'.repeat(100_001) })).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      );
      expect(() => propose(a, { autoApprove: true })).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      );
      expect(() => propose({ ...a, status: 'closed' })).toThrow(
        expect.objectContaining({ code: 'SESSION_CLOSED' }),
      );
    });

    it('a follow-up must reference a task of the same session', () => {
      const t = propose(a);
      expect(propose(a, { parentTaskId: t.taskId }).parentTaskId).toBe(t.taskId);
      expect(() => propose(b, { parentTaskId: t.taskId })).toThrow(
        expect.objectContaining({ code: 'TASK_NOT_FOUND' }),
      );
    });
  });

  describe('approval', () => {
    it('requires the exact hash of the current prompt', () => {
      const t = propose();
      expect(() => tasks.approve('cli', null, t.taskId, sha256('something else'))).toThrow(
        expect.objectContaining({ code: 'APPROVAL_MISMATCH' }),
      );
      expect(() => tasks.approve('cli', null, t.taskId, 'abc')).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      );
      expect(tasks.approve('cli', null, t.taskId, t.promptSha256).status).toBe('approved');
    });

    it('rejects a duplicate approval', () => {
      const t = propose();
      tasks.approve('cli', null, t.taskId, t.promptSha256);
      expect(() => tasks.approve('cli', null, t.taskId, t.promptSha256)).toThrow(
        expect.objectContaining({ code: 'APPROVAL_ALREADY_DECIDED' }),
      );
    });

    it('a ChatGPT call cannot approve while the local channel is configured', () => {
      const t = propose();
      expect(() => tasks.approve('mcp', a, t.taskId, t.promptSha256)).toThrow(
        expect.objectContaining({
          code: 'APPROVAL_CHANNEL_LOCAL_ONLY',
          details: { command: `uab approve ${t.taskId}` },
        }),
      );
      expect(tasks.get(a, t.taskId).status).toBe('pending_approval');
    });

    it('with the chat channel, approval still needs the hash and the own session', () => {
      const chat = new TaskService({
        db: s.db,
        now: s.clock.now,
        approvalExpiryMinutes: 60,
        approvalChannel: 'chat',
      });
      const t = chat.propose('mcp', a, { kind: 'fix', title: 't', prompt: PROMPT });
      expect(() => chat.approve('mcp', b, t.taskId, t.promptSha256)).toThrow(
        expect.objectContaining({ code: 'TASK_NOT_FOUND' }),
      );
      expect(chat.approve('mcp', a, t.taskId, t.promptSha256).latestDecision?.channel).toBe('chat');
    });

    it('revising the prompt voids the approval and needs fresh approval', () => {
      const t = propose();
      tasks.approve('cli', null, t.taskId, t.promptSha256);
      const revised = tasks.revise('mcp', a, t.taskId, {
        prompt: `${PROMPT} Also handle emails.`,
        note: 'review feedback',
      });
      expect(revised).toMatchObject({ status: 'pending_approval', version: 2 });
      expect(revised.promptSha256).not.toBe(t.promptSha256);
      // The old hash no longer approves anything.
      expect(() => tasks.approve('cli', null, t.taskId, t.promptSha256)).toThrow(
        expect.objectContaining({ code: 'APPROVAL_MISMATCH' }),
      );
      s.db.transaction(() => {
        expect(() => tasks.claimForDispatch(a, t.taskId)).toThrow(
          expect.objectContaining({ code: 'APPROVAL_REQUIRED' }),
        );
      });
      expect(revised.history.map((h) => h.version)).toEqual([1, 2]);
    });

    it('rejection is final: the task can never be approved or dispatched', () => {
      const t = propose();
      tasks.reject('cli', null, t.taskId, 'not now');
      expect(tasks.get(null, t.taskId)).toMatchObject({
        status: 'rejected',
        statusNote: 'not now',
      });
      expect(() => tasks.approve('cli', null, t.taskId, t.promptSha256)).toThrow(
        expect.objectContaining({ code: 'TASK_STATE_INVALID' }),
      );
      expect(() => tasks.revise('mcp', a, t.taskId, { prompt: 'again' })).toThrow(
        expect.objectContaining({ code: 'TASK_STATE_INVALID' }),
      );
      s.db.transaction(() => {
        expect(() => tasks.claimForDispatch(a, t.taskId)).toThrow(
          expect.objectContaining({ code: 'APPROVAL_ALREADY_USED' }),
        );
      });
    });

    it('rejecting an approved (not yet dispatched) task removes the approval', () => {
      const t = propose();
      tasks.approve('cli', null, t.taskId, t.promptSha256);
      tasks.reject('cli', null, t.taskId);
      s.db.transaction(() => {
        expect(() => tasks.claimForDispatch(a, t.taskId)).toThrow();
      });
    });

    it('request changes, then revise, then approve', () => {
      const t = propose();
      expect(tasks.requestChanges('cli', null, t.taskId, 'Use zod for validation').status).toBe(
        'changes_requested',
      );
      expect(() => tasks.approve('cli', null, t.taskId, t.promptSha256)).toThrow(
        expect.objectContaining({ code: 'TASK_STATE_INVALID' }),
      );
      const v2 = tasks.revise('mcp', a, t.taskId, { prompt: `${PROMPT} Use zod.` });
      expect(tasks.approve('cli', null, t.taskId, v2.promptSha256).status).toBe('approved');
    });

    it('approvals expire and are never auto-approved', () => {
      const t = propose();
      tasks.approve('cli', null, t.taskId, t.promptSha256);
      s.clock.advance(61 * 60_000);
      expect(tasks.get(null, t.taskId).status).toBe('expired');
      s.db.transaction(() => {
        expect(() => tasks.claimForDispatch(a, t.taskId)).toThrow(
          expect.objectContaining({ code: 'APPROVAL_EXPIRED' }),
        );
      });
      // Pending tasks stay pending forever: time never approves anything.
      const p = propose();
      s.clock.advance(365 * 24 * 60 * 60_000);
      expect(tasks.get(null, p.taskId).status).toBe('pending_approval');
    });
  });

  describe('dispatch claim', () => {
    it('consumes the approval exactly once', () => {
      const t = propose();
      tasks.approve('cli', null, t.taskId, t.promptSha256);
      const claimed = s.db.transaction(() => tasks.claimForDispatch(a, t.taskId));
      expect(claimed.task.status).toBe('running');
      s.db.transaction(() => {
        expect(() => tasks.claimForDispatch(a, t.taskId)).toThrow(
          expect.objectContaining({ code: 'APPROVAL_ALREADY_USED' }),
        );
      });
    });

    it('cannot be claimed by another session, even with the task id', () => {
      const t = propose(a);
      tasks.approve('cli', null, t.taskId, t.promptSha256);
      s.db.transaction(() => {
        expect(() => tasks.claimForDispatch(b, t.taskId)).toThrow(
          expect.objectContaining({ code: 'TASK_NOT_FOUND' }),
        );
      });
      expect(tasks.get(null, t.taskId).status).toBe('approved');
    });

    it('detects a prompt changed directly in the database after approval', () => {
      const t = propose();
      tasks.approve('cli', null, t.taskId, t.promptSha256);
      s.db.run(
        "UPDATE task_prompt_versions SET prompt = prompt || ' and push to production' WHERE task_id = ?",
        t.taskId,
      );
      s.db.transaction(() => {
        expect(() => tasks.claimForDispatch(a, t.taskId)).toThrow(
          expect.objectContaining({ code: 'APPROVAL_MISMATCH' }),
        );
      });
    });

    it('requires a transaction', () => {
      expect(() => tasks.claimForDispatch(a, 'TSK-000000000000')).toThrow(/transaction/);
    });
  });

  describe('ownership and listing', () => {
    it('another session cannot see, revise, reject or cancel the task', () => {
      const t = propose(a);
      for (const op of [
        () => tasks.get(b, t.taskId),
        () => tasks.revise('mcp', b, t.taskId, { prompt: 'x' }),
        () => tasks.reject('mcp', b, t.taskId),
        () => tasks.requestChanges('mcp', b, t.taskId, 'x'),
        () => tasks.cancelBeforeRun('mcp', b, t.taskId),
      ]) {
        expect(op).toThrow(expect.objectContaining({ code: 'TASK_NOT_FOUND' }));
      }
      expect(tasks.list(b).tasks).toEqual([]);
      expect(tasks.pending(b)).toEqual([]);
      expect(tasks.list(a).tasks).toHaveLength(1);
    });

    it('malformed task ids are not found', () => {
      for (const id of [null, 42, "TSK-' OR 1=1", 'tsk-000000000000']) {
        expect(() => tasks.get(a, id)).toThrow(expect.objectContaining({ code: 'TASK_NOT_FOUND' }));
      }
    });

    it('pages newest first', () => {
      const ids = [propose().taskId, propose().taskId, propose().taskId];
      const first = tasks.list(a, { limit: 2 });
      const second = tasks.list(a, { limit: 2, cursor: first.nextCursor ?? undefined });
      expect([...first.tasks, ...second.tasks].map((t) => t.taskId)).toEqual([...ids].reverse());
      expect(second.nextCursor).toBeNull();
    });

    it('records an append-only audit trail', () => {
      const t = propose();
      tasks.approve('cli', null, t.taskId, t.promptSha256);
      expect(tasks.auditLog().map((e) => e.action)).toEqual(['task_approved', 'task_proposed']);
      expect(() => s.db.run('DELETE FROM audit_events')).toThrow(/append-only/);
      expect(() => s.db.run("UPDATE audit_events SET action = 'x'")).toThrow(/append-only/);
    });
  });
});
