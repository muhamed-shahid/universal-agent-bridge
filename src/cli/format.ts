import type { Project } from '../projects/registry.js';
import type { SessionDetails, SessionEventPage } from '../sessions/types.js';

/** Human-readable CLI output. Machine-readable output uses `--json` instead. */

export function formatProjects(projects: readonly Project[]): string {
  if (projects.length === 0) {
    return 'No projects registered. Register one with: uab project add <absolute-path>\n';
  }
  return projects.map((p) => `${p.id}  ${p.name}\n    ${p.path}`).join('\n') + '\n';
}

export function formatSession(s: SessionDetails): string {
  const lines = [
    `Session    ${s.sessionId} (${s.status})`,
    `Title      ${s.title ?? '-'}`,
    `Project    ${s.project.name} (${s.project.id})`,
    `Directory  ${s.project.path}`,
    `Agent      ${s.agentId}`,
    `Agents     ${s.agents.map((a) => a.agentId).join(', ')}`,
    `Created    ${s.createdAt}`,
    `Last used  ${s.lastUsedAt}`,
  ];
  if (s.closedAt !== null) lines.push(`Closed     ${s.closedAt}`);
  if (s.otherActiveSessionsOnProject > 0) {
    lines.push(
      `Warning    ${String(s.otherActiveSessionsOnProject)} other active session(s) use this directory`,
    );
  }
  return lines.join('\n') + '\n';
}

export function formatSessionList(sessions: readonly SessionDetails[]): string {
  if (sessions.length === 0) return 'No sessions.\n';
  return (
    sessions
      .map(
        (s) =>
          `${s.sessionId}  ${s.status.padEnd(6)}  ${s.agentId.padEnd(8)}  ${s.project.name}` +
          (s.title === null ? '' : `  "${s.title}"`),
      )
      .join('\n') + '\n'
  );
}

export function formatToken(
  heading: string,
  s: SessionDetails,
  token: string,
  warnings: readonly string[],
): string {
  return [
    heading,
    `  Session id:  ${s.sessionId}`,
    `  Project:     ${s.project.name} (${s.project.path})`,
    `  Agent:       ${s.agentId}`,
    '',
    'Session token (shown once; UAB stores only a hash of it):',
    `  ${token}`,
    '',
    'Give the session id and token only to the ChatGPT conversation that should own this',
    'session. Anyone with both can use the session. Revoke with: uab session rotate-token <id>',
    ...warnings.map((w) => `\nWarning: ${w}`),
    '',
  ].join('\n');
}

export function formatHistory(page: SessionEventPage): string {
  const lines = page.events.map((e) => {
    const data = Object.keys(e.data).length === 0 ? '' : `  ${JSON.stringify(e.data)}`;
    return `${String(e.id).padStart(5)}  ${e.ts}  ${e.actor.padEnd(6)}  ${e.type}${data}`;
  });
  if (page.nextCursor !== null) lines.push(`(more: --cursor ${page.nextCursor})`);
  return (lines.length === 0 ? 'No events.' : lines.join('\n')) + '\n';
}
