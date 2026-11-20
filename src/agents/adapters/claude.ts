import {
  asRecord,
  asString,
  parseJsonLine,
  type AgentEvent,
  type AgentExecution,
  type InvocationRequest,
} from '../types.js';

/**
 * Claude Code execution: `claude -p --output-format stream-json --verbose`, prompt on stdin.
 *
 * Permissions use Claude Code's own modes:
 * - read-only tasks: `--permission-mode dontAsk` with only Read, Grep and Glob allowed and edit
 *   and shell tools disallowed. dontAsk denies anything not pre-approved.
 * - write tasks: `--permission-mode acceptEdits`, which accepts file edits inside the working
 *   directory. Shell commands still need an allow rule; the user can add scoped rules with
 *   `agents.claude.allowTools` (for example `Bash(npm test:*)`).
 *
 * The stream-json event format was checked against Claude Code 2.1.220; a complete successful
 * run could not be verified on the development machine (its API key was rejected).
 */

const READ_ONLY_ALLOWED = 'Read,Grep,Glob';
const READ_ONLY_DENIED = 'Edit,Write,MultiEdit,NotebookEdit,Bash';

export const claudeExecution: AgentExecution = {
  supported: true,
  verified: false,

  buildInvocation(req: InvocationRequest) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (req.mode === 'read_only') {
      args.push(
        '--permission-mode',
        'dontAsk',
        `--allowedTools=${READ_ONLY_ALLOWED}`,
        `--disallowedTools=${READ_ONLY_DENIED}`,
      );
    } else {
      args.push('--permission-mode', 'acceptEdits');
      const allow = req.settings.allowTools ?? [];
      if (allow.length > 0) args.push(`--allowedTools=${allow.join(',')}`);
    }
    if (req.settings.model !== undefined) args.push('--model', req.settings.model);
    if (req.nativeSessionId !== null) {
      args.push('--resume', req.nativeSessionId);
      return { args, stdin: req.prompt, nativeSessionId: req.nativeSessionId };
    }
    args.push('--session-id', req.newSessionId);
    return { args, stdin: req.prompt, nativeSessionId: req.newSessionId };
  },

  parseStdoutLine(line: string): AgentEvent[] {
    const json = parseJsonLine(line);
    if (json === undefined) return [];
    const events: AgentEvent[] = [];
    const sessionId = asString(json.session_id);
    if (sessionId !== undefined) events.push({ type: 'session', nativeSessionId: sessionId });

    if (json.type === 'system' && json.subtype === 'api_retry') {
      const status = json.error_status;
      if (status === 401 || status === 403) {
        events.push({
          type: 'error',
          message: 'Claude Code could not authenticate with its provider (HTTP 401/403).',
          fatal: true,
        });
      }
    } else if (json.type === 'assistant') {
      const content = asRecord(json.message)?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = asRecord(block);
          if (b?.type === 'text') {
            const text = asString(b.text);
            if (text !== undefined) events.push({ type: 'text', text });
          } else if (b?.type === 'tool_use') {
            const input = asRecord(b.input);
            const p = asString(input?.file_path) ?? asString(input?.path);
            events.push({
              type: 'tool',
              name: asString(b.name) ?? 'tool',
              status: 'started',
              ...(p === undefined ? {} : { path: p }),
            });
          }
        }
      }
    } else if (json.type === 'result') {
      const denials = Array.isArray(json.permission_denials) ? json.permission_denials : [];
      for (const d of denials) {
        events.push({
          type: 'permission_denied',
          tool: asString(asRecord(d)?.tool_name) ?? 'tool',
        });
      }
      const isError = json.is_error === true || json.subtype !== 'success';
      events.push({ type: 'final', text: asString(json.result) ?? '', success: !isError });
      if (isError && json.subtype !== 'success') {
        events.push({
          type: 'error',
          message: `Claude Code finished with ${String(json.subtype)}.`,
        });
      }
    }
    return events;
  },
};
