import {
  asRecord,
  asString,
  parseJsonLine,
  type AgentEvent,
  type AgentExecution,
  type InvocationRequest,
} from '../types.js';

/**
 * Codex CLI execution: `codex exec --json --sandbox <mode> [resume <id>] -`, prompt on stdin.
 *
 * Permissions use Codex's own sandbox: `read-only` for read-only tasks and `workspace-write`
 * (writes limited to the project directory) for write tasks. UAB never passes
 * `danger-full-access`, `--yolo` or the bypass flag.
 *
 * Built from the Codex non-interactive documentation (JSONL events `thread.started`,
 * `item.*`, `turn.completed`, `turn.failed`, `error`). Not run against a real installation.
 */
export const codexExecution: AgentExecution = {
  supported: true,
  verified: false,

  buildInvocation(req: InvocationRequest) {
    const args = [
      'exec',
      '--json',
      '--sandbox',
      req.mode === 'read_only' ? 'read-only' : 'workspace-write',
    ];
    if (req.settings.model !== undefined) args.push('--model', req.settings.model);
    if (req.nativeSessionId !== null) args.push('resume', req.nativeSessionId);
    args.push('-');
    return { args, stdin: req.prompt };
  },

  parseStdoutLine(line: string): AgentEvent[] {
    const json = parseJsonLine(line);
    if (json === undefined) return [];
    const events: AgentEvent[] = [];
    switch (json.type) {
      case 'thread.started': {
        const id = asString(json.thread_id);
        if (id !== undefined) events.push({ type: 'session', nativeSessionId: id });
        break;
      }
      case 'item.started':
      case 'item.completed': {
        const item = asRecord(json.item) ?? {};
        const itemType = asString(item.type);
        const done = json.type === 'item.completed';
        if (itemType === 'agent_message' && done) {
          const text = asString(item.text);
          if (text !== undefined) events.push({ type: 'text', text });
        } else if (itemType === 'command_execution') {
          events.push({
            type: 'tool',
            name: 'command',
            status: asString(item.status) ?? (done ? 'completed' : 'started'),
          });
        } else if (itemType === 'file_change' && done) {
          const changes = Array.isArray(item.changes) ? item.changes : [];
          for (const c of changes) {
            const p = asString(asRecord(c)?.path);
            events.push({
              type: 'tool',
              name: 'file_change',
              status: 'completed',
              ...(p === undefined ? {} : { path: p }),
            });
          }
        }
        break;
      }
      case 'turn.failed': {
        const message = asString(asRecord(json.error)?.message) ?? 'Codex turn failed.';
        events.push({ type: 'error', message, fatal: true });
        break;
      }
      case 'error': {
        events.push({ type: 'error', message: asString(json.message) ?? 'Codex error.' });
        break;
      }
      default:
        break;
    }
    return events;
  },
};
