import type { AgentInfo, AgentStatus } from '../agents/registry.js';
import type { TaskResult } from '../execution/manager.js';
import type { Project } from '../projects/registry.js';
import type { TaskDetails, TaskSummary } from '../tasks/service.js';
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

const STATE_LABEL: Record<AgentStatus['state'], string> = {
  ready: 'Authenticated',
  not_installed: 'Not installed',
  not_authenticated: 'Not authenticated',
  auth_unknown: 'Installed, login status unknown',
  disabled: 'Disabled',
  error: 'Error',
};

export function formatAgentList(agents: readonly AgentInfo[]): string {
  return (
    agents
      .map(
        (a) =>
          `${a.agentId.padEnd(9)} ${a.displayName.padEnd(12)} ${a.enabled ? 'enabled ' : 'disabled'}  ` +
          `task execution: ${a.executionSupported ? 'available' : 'not available'}`,
      )
      .join('\n') + '\n'
  );
}

/** Summary table followed by details and next steps for agents that are not ready. */
export function formatAgentStatus(statuses: readonly AgentStatus[]): string {
  const width = Math.max(...statuses.map((s) => s.displayName.length));
  const lines = statuses.map((s) => {
    const version = s.version === null ? '' : `  ${s.version}`;
    const method = s.auth.method === undefined || s.state !== 'ready' ? '' : ` (${s.auth.method})`;
    return `${s.displayName.padEnd(width)}  ${STATE_LABEL[s.state]}${method}${version}`;
  });

  for (const s of statuses) {
    const details: string[] = [];
    if (s.executable !== null) {
      details.push(
        `  Program: ${s.executable.path}${s.executable.source === 'config' ? ' (from config)' : ''}`,
      );
    }
    if (s.envSet.length > 0) details.push(`  Environment variables set: ${s.envSet.join(', ')}`);
    if (s.auth.detail !== undefined) details.push(`  ${s.auth.detail}`);
    details.push(...s.problems.map((p) => `  ${p}`));
    if (s.state === 'not_installed') {
      details.push('  Install:', ...s.instructions.install.map((i) => `    ${i}`));
      details.push(`  Docs: ${s.instructions.docsUrl}`);
    } else if (s.state === 'not_authenticated' || s.state === 'auth_unknown') {
      details.push(
        '  Log in with the CLI itself (UAB never asks for your credentials):',
        ...s.instructions.authenticate.map((i) => `    ${i}`),
      );
    } else if (s.state === 'disabled') {
      details.push(`  Enable it by removing agents.${s.agentId}.enabled from the UAB config.`);
    }
    details.push(...s.notes.map((n) => `  Note: ${n}`));
    lines.push('', `${s.displayName} [${s.agentId}]`, ...details);
  }
  lines.push(
    '',
    'UAB never asks for your credentials. Each CLI keeps its own login and permission settings.',
    '',
  );
  return lines.join('\n');
}

// ------------------------------------------------------------------ tasks

export function formatTaskList(tasks: readonly TaskSummary[]): string {
  if (tasks.length === 0) return 'No tasks.\n';
  return (
    tasks
      .map(
        (t) =>
          `${t.taskId}  ${t.status.padEnd(17)}  ${t.agentId.padEnd(8)}  ${t.kind.padEnd(9)}  ${t.title}` +
          `\n    session ${t.sessionId}, v${String(t.version)}, ${t.updatedAt}`,
      )
      .join('\n') + '\n'
  );
}

const RULE = '-'.repeat(72);

/** Everything the user needs to decide, including the complete prompt and its hash. */
export function formatApprovalRequest(t: TaskDetails): string {
  return [
    RULE,
    `PENDING APPROVAL  ${t.taskId}  (version ${String(t.version)})`,
    RULE,
    `Title       ${t.title}`,
    `Agent       ${t.agentId}`,
    `Project     ${t.projectName}`,
    `Directory   ${t.projectPath}`,
    `Session     ${t.sessionId}`,
    `Kind        ${t.kind} (${t.mode === 'read_only' ? 'read-only' : 'may change files in the project'})`,
    `Agent conversation  ${t.freshAgentSession ? 'new' : "continues this session's conversation with this agent, if any"}`,
    `Verification        ${t.verifyCommand === null ? 'none configured' : `UAB runs afterwards: ${t.verifyCommand.join(' ')}`}`,
    t.latestDecision === null
      ? ''
      : `Last decision       ${t.latestDecision.decision} (v${String(t.latestDecision.promptVersion)}) ${t.latestDecision.note ?? ''}`,
    RULE,
    'Prompt the agent will receive (exactly):',
    RULE,
    t.prompt,
    RULE,
    `SHA-256  ${t.promptSha256}`,
    RULE,
    "The agent's own permission settings still apply to every file change and command.",
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export function formatTaskDetails(t: TaskDetails): string {
  return (
    formatApprovalRequest(t).replace('PENDING APPROVAL', `TASK (${t.status})`) +
    (t.statusNote === null ? '' : `Note: ${t.statusNote}\n`)
  );
}

export function formatResult(r: TaskResult): string {
  const v = r.verification;
  const lines = [
    `Result of ${r.taskId}: ${r.status}  (${String(Math.round(r.durationMs / 1000))} s, exit ${String(r.exitCode)})`,
    `Agent says success:     ${r.agentReportedSuccess === null ? 'unknown' : r.agentReportedSuccess ? 'yes (not verified)' : 'no'}`,
    `UAB verification:       ${v.status}${v.command === null ? '' : ` (${v.command.join(' ')}${v.exitCode === null ? '' : `, exit ${String(v.exitCode)}`})`}`,
    `Permission denials:     ${String(r.permissionDenials.count)}${r.permissionDenials.tools.length > 0 ? ` (${r.permissionDenials.tools.join(', ')})` : ''}`,
    `Changed files:          ${String(r.git.changedFiles.length)}${r.git.commitsCreated > 0 ? `, commits created: ${String(r.git.commitsCreated)}` : ''}`,
    ...r.git.changedFiles
      .slice(0, 30)
      .map(
        (f) =>
          `    ${f.change.padEnd(8)} ${f.path}${f.preExisting ? ' (already changed before)' : ''}`,
      ),
    ...r.warnings.map((w) => `Warning: ${w}`),
    ...r.errors.map((e) => `Error: ${e}`),
    ...(r.setupHint === null ? [] : [`Hint: ${r.setupHint}`]),
    '',
    'Final message from the agent:',
    r.finalMessage === '' ? '(none)' : r.finalMessage,
    '',
  ];
  return lines.join('\n');
}
