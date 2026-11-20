import { describe, expect, it } from 'vitest';
import { BUILTIN_AGENTS } from '../../../src/agents/adapters/builtin.js';
import { claudeExecution } from '../../../src/agents/adapters/claude.js';
import { codexExecution } from '../../../src/agents/adapters/codex.js';
import {
  KIRO_READ_PROFILE,
  KIRO_WRITE_PROFILE,
  installKiroProfiles,
  kiroExecution,
  kiroProfiles,
} from '../../../src/agents/adapters/kiro.js';
import { opencodeExecution } from '../../../src/agents/adapters/opencode.js';
import { findForbiddenArg } from '../../../src/agents/args.js';
import type { AgentExecution, InvocationRequest, TaskMode } from '../../../src/agents/types.js';
import { makeTempDir, removeDir } from '../../helpers/fs.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const req = (mode: TaskMode, extra: Partial<InvocationRequest> = {}): InvocationRequest => ({
  prompt: 'Do the thing',
  cwd: '/repo',
  mode,
  nativeSessionId: null,
  newSessionId: '11111111-2222-3333-4444-555555555555',
  settings: {},
  ...extra,
});

const parseAll = (exec: AgentExecution, lines: string[]) =>
  lines.flatMap((l) => exec.parseStdoutLine(l));

describe('every adapter', () => {
  for (const def of BUILTIN_AGENTS) {
    const exec = def.execution;
    if (exec === undefined) continue;
    it(`${def.id}: sends the prompt on stdin, never in arguments, and uses no forbidden flag`, () => {
      for (const mode of ['read_only', 'workspace_write'] as const) {
        for (const nativeSessionId of [null, 'abc-123']) {
          const inv = exec.buildInvocation(
            req(mode, { nativeSessionId, prompt: 'SECRET PROMPT --yolo' }),
          );
          expect(inv.stdin).toBe('SECRET PROMPT --yolo');
          expect(inv.args.join(' ')).not.toContain('SECRET PROMPT');
          expect(findForbiddenArg(inv.args, def.forbiddenArgs)).toBeUndefined();
          if (nativeSessionId !== null) expect(inv.args).toContain('abc-123');
        }
      }
    });
    it(`${def.id}: ignores non-JSON and unknown lines`, () => {
      expect(exec.parseStdoutLine('plain text')).toEqual([]);
      expect(exec.parseStdoutLine('{"type":"something_new"}')).toEqual([]);
      expect(exec.parseStdoutLine('{broken')).toEqual([]);
    });
  }
});

describe('Kiro CLI adapter (real output, Kiro CLI 2.27.1)', () => {
  it('uses the UAB profiles and never trust flags', () => {
    expect(kiroExecution.buildInvocation(req('read_only')).args).toEqual([
      'chat',
      '--no-interactive',
      '--output-format',
      'stream-json',
      '--agent',
      KIRO_READ_PROFILE,
    ]);
    const w = kiroExecution.buildInvocation(
      req('workspace_write', { nativeSessionId: 'sid', settings: { model: 'claude-sonnet' } }),
    ).args;
    expect(w).toEqual([
      'chat',
      '--no-interactive',
      '--output-format',
      'stream-json',
      '--agent',
      KIRO_WRITE_PROFILE,
      '--model',
      'claude-sonnet',
      '--resume-id',
      'sid',
    ]);
    expect(w.join(' ')).not.toMatch(/trust/);
    expect(
      kiroExecution.buildInvocation(req('workspace_write', { settings: { profile: 'my-agent' } }))
        .args,
    ).toContain('my-agent');
  });

  const sid = '749bacbf-ad0a-4894-a615-54a538e680ce';
  const lines = [
    '{"type":"runStarted","data":{"payloadSchema":"acp","acpProtocolVersion":1,"engine":"v2"}}',
    `{"type":"metadata","data":{"sessionId":"${sid}","contextUsagePercentage":3.5}}`,
    `{"type":"sessionUpdate","data":{"sessionId":"${sid}","update":{"sessionUpdate":"tool_call","toolCallId":"t1","title":"Reading hello.txt:1","kind":"read","locations":[{"path":"hello.txt"}],"_meta":{"kiro":{"toolName":"read"}}}}}`,
    `{"type":"sessionUpdate","data":{"sessionId":"${sid}","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"UAB_OK hello"}}}}`,
    `{"type":"sessionUpdate","data":{"sessionId":"${sid}","update":{"sessionUpdate":"tool_call_update","toolCallId":"t2","kind":"edit","status":"failed","title":"write","content":[{"type":"content","content":{"type":"text","text":"Permission request failed: Internal error: {\\n  \\"reason\\": \\"tool permission approval is not supported in non-interactive mode.\\"}"}}],"_meta":{"kiro":{"toolName":"write"}}}}}`,
    `{"type":"runFinished","data":{"sessionId":"${sid}","status":"success","stopReason":"end_turn","finalText":"UAB_OK hello from a probe file","finalTextTruncated":false}}`,
  ];

  it('extracts session id, text, tools, denials and the final message', () => {
    const events = parseAll(kiroExecution, lines);
    expect(events.find((e) => e.type === 'session')).toEqual({
      type: 'session',
      nativeSessionId: sid,
    });
    expect(events).toContainEqual({ type: 'text', text: 'UAB_OK hello' });
    expect(events).toContainEqual({
      type: 'tool',
      name: 'read',
      status: 'started',
      path: 'hello.txt',
    });
    expect(events).toContainEqual({ type: 'permission_denied', tool: 'write' });
    expect(events.at(-1)).toEqual({
      type: 'final',
      text: 'UAB_OK hello from a probe file',
      success: true,
    });
  });

  it('reports runError (for example a missing profile) as fatal', () => {
    const events = kiroExecution.parseStdoutLine(
      `{"type":"runError","data":{"sessionId":"${sid}","stage":"init","message":"failed to set agent 'uab-write': Mode 'uab-write' not found"}}`,
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', fatal: true }));
  });

  it('profiles allow files only inside the working directory and pre-approve no tool', () => {
    const [read, write] = kiroProfiles();
    expect(read).toMatchObject({
      name: 'uab-read',
      allowedTools: [],
      toolsSettings: { fs_read: { allowedPaths: ['./**'] } },
    });
    expect(write).toMatchObject({
      name: 'uab-write',
      allowedTools: [],
      toolsSettings: { fs_write: { allowedPaths: ['./**'] } },
    });
    expect(JSON.stringify(kiroProfiles())).not.toMatch(/execute_bash|shell|use_aws|execute_cmd/);
  });

  it('installs profiles idempotently and never overwrites a foreign file', () => {
    const home = makeTempDir('uab-kiro-home-');
    try {
      const first = installKiroProfiles(home);
      expect(first.written).toHaveLength(2);
      expect(installKiroProfiles(home).unchanged).toHaveLength(2);
      const file = path.join(home, '.kiro', 'agents', 'uab-write.json');
      expect((JSON.parse(readFileSync(file, 'utf8')) as { name: string }).name).toBe('uab-write');
      writeFileSync(file, '{"name":"uab-write","mine":true}');
      expect(() => installKiroProfiles(home)).toThrow(/not created by UAB/);
      mkdirSync(path.join(home, 'x'));
    } finally {
      removeDir(home);
    }
  });
});

describe('Claude Code adapter', () => {
  it('read-only: dontAsk with read tools only; write: acceptEdits plus configured rules', () => {
    const r = claudeExecution.buildInvocation(req('read_only'));
    expect(r.args).toEqual(
      expect.arrayContaining([
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'dontAsk',
        '--allowedTools=Read,Grep,Glob',
      ]),
    );
    expect(r.args.find((a) => a.startsWith('--disallowedTools='))).toContain('Bash');
    expect(r.nativeSessionId).toBe('11111111-2222-3333-4444-555555555555');
    expect(r.args).toContain('--session-id');
    const w = claudeExecution.buildInvocation(
      req('workspace_write', {
        nativeSessionId: 'prev',
        settings: { allowTools: ['Bash(npm test:*)'] },
      }),
    );
    expect(w.args).toEqual(
      expect.arrayContaining([
        '--permission-mode',
        'acceptEdits',
        '--allowedTools=Bash(npm test:*)',
        '--resume',
        'prev',
      ]),
    );
    expect(w.args).not.toContain('--session-id');
  });

  it('parses stream-json (init, assistant, result with denials)', () => {
    const events = parseAll(claudeExecution, [
      '{"type":"system","subtype":"init","cwd":"/repo","session_id":"72f2","permissionMode":"dontAsk"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Looking"},{"type":"tool_use","name":"Edit","input":{"file_path":"/repo/a.ts"}}]},"session_id":"72f2"}',
      '{"type":"result","subtype":"success","is_error":false,"result":"All done","session_id":"72f2","permission_denials":[{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}]}',
    ]);
    expect(events).toContainEqual({ type: 'session', nativeSessionId: '72f2' });
    expect(events).toContainEqual({
      type: 'tool',
      name: 'Edit',
      status: 'started',
      path: '/repo/a.ts',
    });
    expect(events).toContainEqual({ type: 'permission_denied', tool: 'Bash' });
    expect(events).toContainEqual({ type: 'final', text: 'All done', success: true });
    expect(JSON.stringify(events)).not.toContain('rm -rf');
  });

  it('turns a provider 401 (real retry event from 2.1.220) into a fatal error', () => {
    const events = claudeExecution.parseStdoutLine(
      '{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":597,"error_status":401,"error":"authentication_failed","session_id":"72f2"}',
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', fatal: true }));
  });

  it('reports error results', () => {
    const events = claudeExecution.parseStdoutLine(
      '{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"s"}',
    );
    expect(events).toContainEqual({ type: 'final', text: '', success: false });
  });
});

describe('OpenCode adapter', () => {
  it('read-only uses the plan agent; write uses the configured profile; --dir is the project', () => {
    expect(opencodeExecution.buildInvocation(req('read_only')).args).toEqual([
      'run',
      '--format',
      'json',
      '--dir',
      '/repo',
      '--agent',
      'plan',
    ]);
    expect(opencodeExecution.buildInvocation(req('workspace_write')).args).toEqual([
      'run',
      '--format',
      'json',
      '--dir',
      '/repo',
    ]);
    expect(
      opencodeExecution.buildInvocation(
        req('workspace_write', { settings: { profile: 'build' }, nativeSessionId: 'ses_1' }),
      ).args,
    ).toEqual([
      'run',
      '--format',
      'json',
      '--dir',
      '/repo',
      '--agent',
      'build',
      '--session',
      'ses_1',
    ]);
  });

  it('parses the real error event from 1.19.3 without copying headers', () => {
    const line =
      '{"type":"error","timestamp":1795175288291,"sessionID":"ses_e073","error":{"name":"APIError","data":{"message":"credit insufficient balance","statusCode":400,"responseHeaders":{"x-oneapi-request-id":"abc"}}}}';
    const events = opencodeExecution.parseStdoutLine(line);
    expect(events).toEqual([
      { type: 'session', nativeSessionId: 'ses_e073' },
      { type: 'error', message: 'credit insufficient balance', fatal: true },
    ]);
  });

  it('parses text and tool events', () => {
    const events = parseAll(opencodeExecution, [
      '{"type":"text","sessionID":"s","part":{"type":"text","text":"hello"}}',
      '{"type":"tool_use","sessionID":"s","part":{"tool":"edit","state":{"status":"error","input":{"filePath":"/repo/a"},"error":"The user rejected permission to use this tool"}}}',
    ]);
    expect(events).toContainEqual({ type: 'text', text: 'hello' });
    expect(events).toContainEqual({ type: 'permission_denied', tool: 'edit' });
  });
});

describe('Codex CLI adapter (documentation-based)', () => {
  it('uses the native sandbox and reads the prompt from stdin', () => {
    expect(codexExecution.buildInvocation(req('read_only')).args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '-',
    ]);
    expect(
      codexExecution.buildInvocation(req('workspace_write', { nativeSessionId: 't1' })).args,
    ).toEqual(['exec', '--json', '--sandbox', 'workspace-write', 'resume', 't1', '-']);
  });

  it('parses the documented JSONL events', () => {
    const events = parseAll(codexExecution, [
      '{"type":"thread.started","thread_id":"0199a213-81c0"}',
      '{"type":"turn.started"}',
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs."}}',
      '{"type":"turn.completed","usage":{"input_tokens":1}}',
    ]);
    expect(events).toEqual([
      { type: 'session', nativeSessionId: '0199a213-81c0' },
      { type: 'tool', name: 'command', status: 'in_progress' },
      { type: 'text', text: 'Repo contains docs.' },
    ]);
    expect(
      codexExecution.parseStdoutLine('{"type":"turn.failed","error":{"message":"boom"}}'),
    ).toEqual([{ type: 'error', message: 'boom', fatal: true }]);
  });
});
