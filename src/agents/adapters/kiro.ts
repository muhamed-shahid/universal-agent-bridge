import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  asRecord,
  asString,
  parseJsonLine,
  type AgentEvent,
  type AgentExecution,
  type InvocationRequest,
} from '../types.js';

/**
 * Kiro CLI execution (verified with Kiro CLI 2.27.1, V2 engine, on Windows 11).
 *
 * Kiro's headless mode denies every tool call it cannot ask about. UAB runs Kiro with one of
 * two agent profiles that UAB installs in `~/.kiro/agents` (`uab agents setup kiro`):
 *
 * - `uab-read`:  file reads allowed inside the working directory only.
 * - `uab-write`: file reads and writes allowed inside the working directory only.
 *
 * Shell commands, web access, AWS and MCP tools are not pre-approved, so headless Kiro denies
 * them. Paths outside the project are denied by Kiro itself (`allowedPaths: ["./**"]`).
 * UAB never passes `--trust-all-tools` or `--trust-tools`.
 */

export const KIRO_READ_PROFILE = 'uab-read';
export const KIRO_WRITE_PROFILE = 'uab-write';

export function kiroProfiles(): Record<string, unknown>[] {
  const description =
    'Installed by Universal Agent Bridge. Tools run without asking only inside the working directory.';
  return [
    {
      name: KIRO_READ_PROFILE,
      description: `${description} Read-only.`,
      tools: ['*'],
      allowedTools: [],
      toolsSettings: { fs_read: { allowedPaths: ['./**'] } },
    },
    {
      name: KIRO_WRITE_PROFILE,
      description: `${description} Reads and writes files.`,
      tools: ['*'],
      allowedTools: [],
      toolsSettings: {
        fs_read: { allowedPaths: ['./**'] },
        fs_write: { allowedPaths: ['./**'] },
      },
    },
  ];
}

export function kiroAgentsDir(homedir = os.homedir()): string {
  return path.join(homedir, '.kiro', 'agents');
}

export interface KiroSetupResult {
  readonly directory: string;
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
}

/** Writes the UAB profiles. Refuses to overwrite a file UAB did not create. */
export function installKiroProfiles(homedir = os.homedir()): KiroSetupResult {
  const directory = kiroAgentsDir(homedir);
  mkdirSync(directory, { recursive: true });
  const written: string[] = [];
  const unchanged: string[] = [];
  for (const profile of kiroProfiles()) {
    const name = String(profile.name);
    const file = path.join(directory, `${name}.json`);
    const content = JSON.stringify(profile, null, 2) + '\n';
    if (existsSync(file)) {
      const current = readFileSync(file, 'utf8');
      if (current === content) {
        unchanged.push(file);
        continue;
      }
      if (!current.includes('Installed by Universal Agent Bridge')) {
        throw new Error(`${file} exists and was not created by UAB. Remove or rename it first.`);
      }
    }
    writeFileSync(file, content);
    written.push(file);
  }
  return { directory, written, unchanged };
}

export function kiroProfilesInstalled(homedir = os.homedir()): boolean {
  return kiroProfiles().every((p) =>
    existsSync(path.join(kiroAgentsDir(homedir), `${String(p.name)}.json`)),
  );
}

const DENIED = /not supported in non-interactive mode|Permission request failed|\[denied\]/i;

export const kiroExecution: AgentExecution = {
  supported: true,
  verified: true,
  setupHint: 'Run `uab agents setup kiro` to install the UAB profiles, then retry.',

  buildInvocation(req: InvocationRequest) {
    const profile =
      req.settings.profile ?? (req.mode === 'read_only' ? KIRO_READ_PROFILE : KIRO_WRITE_PROFILE);
    const args = ['chat', '--no-interactive', '--output-format', 'stream-json', '--agent', profile];
    if (req.settings.model !== undefined) args.push('--model', req.settings.model);
    if (req.nativeSessionId !== null) args.push('--resume-id', req.nativeSessionId);
    return { args, stdin: req.prompt };
  },

  parseStdoutLine(line: string): AgentEvent[] {
    const json = parseJsonLine(line);
    if (json === undefined) return [];
    const data = asRecord(json.data) ?? {};
    const events: AgentEvent[] = [];
    const sessionId = asString(data.sessionId);
    if (sessionId !== undefined && json.type !== 'metadata') {
      events.push({ type: 'session', nativeSessionId: sessionId });
    }
    switch (json.type) {
      case 'sessionUpdate': {
        const update = asRecord(data.update) ?? {};
        const kind = asString(update.sessionUpdate);
        if (kind === 'agent_message_chunk') {
          const text = asString(asRecord(update.content)?.text);
          if (text !== undefined) events.push({ type: 'text', text });
        } else if (kind === 'tool_call' || kind === 'tool_call_update') {
          const name =
            asString(asRecord(asRecord(update._meta)?.kiro)?.toolName) ??
            asString(update.kind) ??
            'tool';
          const status = asString(update.status) ?? 'started';
          const location = asRecord((update.locations as unknown[] | undefined)?.[0]);
          const p = asString(location?.path);
          events.push({ type: 'tool', name, status, ...(p === undefined ? {} : { path: p }) });
          if (status === 'failed' && DENIED.test(JSON.stringify(update.content ?? ''))) {
            events.push({ type: 'permission_denied', tool: name });
          }
        }
        break;
      }
      case 'runFinished': {
        const text = asString(data.finalText) ?? '';
        events.push({ type: 'final', text, success: data.status === 'success' });
        break;
      }
      case 'runError': {
        events.push({
          type: 'error',
          message: asString(data.message) ?? 'Kiro reported an error.',
          fatal: true,
        });
        break;
      }
      default:
        break;
    }
    return events;
  },

  // Kiro prints one `[denied] …` line per refused tool call on stderr; the matching
  // tool_call_update on stdout is counted instead, so stderr adds no events.
  parseStderrLine: () => [],
};
