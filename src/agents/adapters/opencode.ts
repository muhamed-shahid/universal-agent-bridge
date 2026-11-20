import {
  asRecord,
  asString,
  parseJsonLine,
  type AgentEvent,
  type AgentExecution,
  type InvocationRequest,
} from '../types.js';

/**
 * OpenCode execution: `opencode run --format json --dir <project>`, prompt on stdin (checked
 * with OpenCode 1.19.3: the session received the stdin text as the user message).
 *
 * Permissions are OpenCode's own `permission` settings from the user's opencode config. UAB
 * never passes `--auto`. Read-only tasks use OpenCode's built-in `plan` agent, which does not
 * edit files. For write tasks UAB uses the configured `agents.opencode.profile`, or OpenCode's
 * default agent. Note that OpenCode's default agent may allow edits and shell commands; the
 * user should configure `permission` (see docs/supported-agents.md).
 *
 * Error events were checked against 1.19.3. A complete successful run could not be verified on
 * the development machine (the provider account had no credit).
 */
export const opencodeExecution: AgentExecution = {
  supported: true,
  verified: false,

  buildInvocation(req: InvocationRequest) {
    const args = ['run', '--format', 'json', '--dir', req.cwd];
    const agent = req.mode === 'read_only' ? 'plan' : req.settings.profile;
    if (agent !== undefined) args.push('--agent', agent);
    if (req.settings.model !== undefined) args.push('--model', req.settings.model);
    if (req.nativeSessionId !== null) args.push('--session', req.nativeSessionId);
    return { args, stdin: req.prompt };
  },

  parseStdoutLine(line: string): AgentEvent[] {
    const json = parseJsonLine(line);
    if (json === undefined) return [];
    const events: AgentEvent[] = [];
    const sessionId = asString(json.sessionID);
    if (sessionId !== undefined) events.push({ type: 'session', nativeSessionId: sessionId });
    const part = asRecord(json.part);

    switch (json.type) {
      case 'text': {
        const text = asString(part?.text);
        if (text !== undefined) events.push({ type: 'text', text });
        break;
      }
      case 'tool_use': {
        const state = asRecord(part?.state);
        const status = asString(state?.status) ?? 'started';
        const input = asRecord(state?.input);
        const p = asString(input?.filePath) ?? asString(input?.path);
        const name = asString(part?.tool) ?? 'tool';
        events.push({ type: 'tool', name, status, ...(p === undefined ? {} : { path: p }) });
        const error = asString(state?.error) ?? '';
        if (status === 'error' && /permission|rejected|denied/i.test(error)) {
          events.push({ type: 'permission_denied', tool: name });
        }
        break;
      }
      case 'error': {
        const error = asRecord(json.error);
        const message =
          asString(asRecord(error?.data)?.message) ?? asString(error?.name) ?? 'OpenCode error.';
        events.push({ type: 'error', message, fatal: true });
        break;
      }
      default:
        break;
    }
    return events;
  },
};
