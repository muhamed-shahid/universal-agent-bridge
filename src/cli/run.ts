import path from 'node:path';
import { parseArgs } from 'node:util';
import { installKiroProfiles, kiroAgentsDir } from '../agents/adapters/kiro.js';
import { openApp, type App, type AppOptions } from '../app.js';
import { loadConfig } from '../core/config.js';
import { ErrorCode, UabError, toErrorPayload } from '../core/errors.js';
import { VERSION } from '../core/version.js';
import { currentSchemaVersion, MIGRATIONS } from '../database/index.js';
import { codexConfigPath, mcpConfigToml } from '../mcp/config.js';
import { runMcpStdio } from '../mcp/stdio.js';
import { TASK_ID_PATTERN } from '../tasks/service.js';
import {
  formatAgentList,
  formatAgentStatus,
  formatApprovalRequest,
  formatHistory,
  formatProjects,
  formatResult,
  formatSession,
  formatSessionList,
  formatTaskDetails,
  formatTaskList,
  formatToken,
} from './format.js';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Reads one line from the user. Absent when input is not interactive. */
  readonly readLine?: (question: string) => Promise<string>;
}

const HELP = `Universal Agent Bridge (uab) ${VERSION}

Usage:
  uab <command> [options]

Connect ChatGPT:
  mcp                                   Run the MCP server (started by the ChatGPT desktop app)
  mcp-config                            Print the config block for ~/.codex/config.toml

Projects:
  project add <path> [--name <name>]    Register a project directory (absolute path)
  project list                          List registered projects
  project set-test <project> -- <command...>
                                        Command UAB runs to verify write tasks (no shell)
  project clear-test <project>          Remove the verification command
  project remove <project-id>           Remove a project that has no sessions

Sessions:
  session create --project <path|id> --agent <agent> [--title <title>]
                                        Create a session and print its token once
  session list [--all]                  List active sessions (--all includes closed)
  session show <session-id>             Show a session
  session history <session-id> [--cursor <n>] [--limit <n>]
  session close <session-id>            Close a session
  session rotate-token <session-id>     Issue a new token; the old one stops working

Approvals and tasks:
  pending                               List tasks waiting for your approval
  approve <task-id> [--sha256 <hash> --yes]
                                        Show the full prompt and approve it
  reject <task-id> [--reason <text>]    Reject a task; it can never run
  request-changes <task-id> --note <text>
                                        Send a task back to ChatGPT for changes
  tasks [--session <id>] [--status <s>] [--limit <n>]
                                        List tasks
  task show <task-id>                   Show a task and its prompt
  task run <task-id>                    Dispatch an approved task here and wait for it
  task result <task-id>                 Show a task's result
  task logs <task-id> [--limit <n>]     Show a task's redacted output
  task cancel <task-id>                 Cancel a waiting or running task
  audit [--limit <n>]                   Show the audit log

Agents:
  agents list                           List supported coding agents
  agents status [<agent>]               Installed? Version? Logged in?
  agents setup kiro                     Install the UAB profiles for Kiro CLI

Maintenance:
  config                                Show the data directory and settings
  db status                             Show the database file and schema version
  db backup <absolute-file>             Write a consistent copy of the database

Options:
  -h, --help     Show help
  -v, --version  Show version
      --json     Machine-readable output

Agents: kiro (Kiro CLI), claude (Claude Code), opencode (OpenCode), codex (Codex CLI)

Environment:
  UAB_HOME       Absolute path of the data directory
  UAB_CONFIG     Absolute path of the JSON config file
  UAB_LOG_LEVEL  debug | info | warn | error
`;

type Values = {
  json?: boolean;
  name?: string;
  project?: string;
  agent?: string;
  title?: string;
  all?: boolean;
  cursor?: string;
  limit?: string;
  sha256?: string;
  yes?: boolean;
  reason?: string;
  note?: string;
  session?: string;
  status?: string;
  'uab-home'?: string;
};

function usage(message: string): UabError {
  return new UabError(ErrorCode.INVALID_ARGUMENT, message);
}

function required(value: string | undefined, what: string): string {
  if (value === undefined || value.trim() === '') throw usage(`Missing ${what}.`);
  return value;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function limitOf(values: Values, fallback: number): number {
  if (values.limit === undefined) return fallback;
  const n = Number(values.limit);
  if (!Number.isInteger(n) || n < 1) throw usage('--limit must be a positive integer.');
  return n;
}

function historyQuery(values: Values): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  if (values.cursor !== undefined) query.cursor = values.cursor;
  if (values.limit !== undefined) query.limit = Number(values.limit);
  return query;
}

function taskIdArg(arg: string | undefined): string {
  const id = required(arg, 'task id').trim().toUpperCase();
  if (!TASK_ID_PATTERN.test(id)) throw usage('A task id looks like TSK-XXXXXXXXXXXX.');
  return id;
}

function runProject(app: App, args: readonly string[], values: Values): string {
  const [sub, arg, ...rest] = args;
  switch (sub) {
    case 'add': {
      const { project, created } = app.projects.register(
        required(arg, 'project directory path'),
        values.name,
      );
      if (values.json === true) return json({ project, created });
      return `${created ? 'Registered' : 'Already registered'}: ${project.id}  ${project.name}\n    ${project.path}\n`;
    }
    case 'list': {
      const projects = app.projects.list();
      if (values.json === true)
        return json(projects.map((p) => ({ ...p, testCommand: app.projects.testCommand(p.id) })));
      return (
        formatProjects(projects) +
        projects
          .map((p) => ({ p, t: app.projects.testCommand(p.id) }))
          .filter((x) => x.t !== null)
          .map((x) => `    ${x.p.id} verifies with: ${(x.t ?? []).join(' ')}\n`)
          .join('')
      );
    }
    case 'set-test': {
      const project = app.projects.resolve(required(arg, 'project id or path'));
      if (rest.length === 0)
        throw usage(
          'Give the command after --, for example: uab project set-test <project> -- npm test',
        );
      app.projects.setTestCommand(project.id, rest);
      return `${project.name}: UAB will run \`${rest.join(' ')}\` after each write task to verify it.\n`;
    }
    case 'clear-test': {
      const project = app.projects.resolve(required(arg, 'project id or path'));
      app.projects.setTestCommand(project.id, null);
      return `${project.name}: verification command removed.\n`;
    }
    case 'remove': {
      const id = required(arg, 'project id');
      app.projects.remove(id);
      return values.json === true ? json({ removed: id }) : `Removed ${id}\n`;
    }
    default:
      throw usage(`Unknown project command: ${sub ?? '(none)'}`);
  }
}

function runSession(app: App, args: readonly string[], values: Values): string {
  const [sub, arg] = args;
  switch (sub) {
    case 'create': {
      const created = app.sessions('cli').create({
        project: required(values.project, '--project'),
        agentId: required(values.agent, '--agent'),
        ...(values.title === undefined ? {} : { title: values.title }),
      });
      return values.json === true
        ? json(created)
        : formatToken('Session created.', created.session, created.sessionToken, created.warnings);
    }
    case 'list': {
      const sessions = app.sessionAdmin.list({ includeClosed: values.all === true });
      return values.json === true ? json(sessions) : formatSessionList(sessions);
    }
    case 'show': {
      const session = app.sessionAdmin.get(required(arg, 'session id'));
      return values.json === true ? json(session) : formatSession(session);
    }
    case 'history': {
      const page = app.sessionAdmin.history(required(arg, 'session id'), historyQuery(values));
      return values.json === true ? json(page) : formatHistory(page);
    }
    case 'close': {
      const session = app.sessionAdmin.close(required(arg, 'session id'));
      return values.json === true ? json(session) : `Closed ${session.sessionId}\n`;
    }
    case 'rotate-token': {
      const { session, sessionToken } = app.sessionAdmin.rotateToken(required(arg, 'session id'));
      return values.json === true
        ? json({ session, sessionToken })
        : formatToken(
            'New session token issued. The previous token no longer works.',
            session,
            sessionToken,
            [],
          );
    }
    default:
      throw usage(`Unknown session command: ${sub ?? '(none)'}`);
  }
}

async function runAgents(
  app: App,
  args: readonly string[],
  values: Values,
  options: AppOptions,
): Promise<string> {
  const [sub, arg] = args;
  switch (sub) {
    case 'list': {
      const agents = app.agents.list();
      return values.json === true ? json(agents) : formatAgentList(agents);
    }
    case 'status': {
      const statuses =
        arg === undefined ? await app.agents.statusAll() : [await app.agents.status(arg)];
      return values.json === true ? json(statuses) : formatAgentStatus(statuses);
    }
    case 'setup': {
      if (arg !== 'kiro')
        throw usage(
          'Only `uab agents setup kiro` is needed; the other agents use their own settings.',
        );
      let result;
      try {
        result = installKiroProfiles(options.homedir);
      } catch (error) {
        throw new UabError(
          ErrorCode.INVALID_ARGUMENT,
          error instanceof Error ? error.message : String(error),
        );
      }
      if (values.json === true) return json(result);
      return [
        `Kiro profiles in ${kiroAgentsDir(options.homedir)}:`,
        ...result.written.map((f) => `  written    ${f}`),
        ...result.unchanged.map((f) => `  unchanged  ${f}`),
        '',
        'uab-read  lets Kiro read files inside the project directory without asking.',
        'uab-write also lets Kiro create and edit files inside the project directory.',
        'Everything else (shell commands, web, files outside the project) stays denied',
        "in headless runs, by Kiro's own permission system.",
        '',
      ].join('\n');
    }
    default:
      throw usage(`Unknown agents command: ${sub ?? '(none)'}`);
  }
}

function runDb(app: App, args: readonly string[], values: Values): string {
  const [sub, arg] = args;
  switch (sub) {
    case 'status': {
      const status = {
        file: app.db.file,
        schemaVersion: currentSchemaVersion(app.db),
        latestVersion: MIGRATIONS.length,
        migratedNow: app.migration.applied,
        backupFile: app.migration.backupFile ?? null,
      };
      if (values.json === true) return json(status);
      return [
        `Database        ${status.file}`,
        `Schema version  ${String(status.schemaVersion)} (latest ${String(status.latestVersion)})`,
        ...(status.migratedNow.length > 0
          ? [`Migrated now    ${status.migratedNow.join(', ')}`]
          : []),
        ...(status.backupFile === null ? [] : [`Backup written  ${status.backupFile}`]),
        '',
      ].join('\n');
    }
    case 'backup': {
      const target = required(arg, 'backup file path');
      if (!path.isAbsolute(target)) throw usage('Backup path must be absolute.');
      app.db.backupTo(target);
      return values.json === true ? json({ backupFile: target }) : `Backup written: ${target}\n`;
    }
    default:
      throw usage(`Unknown db command: ${sub ?? '(none)'}`);
  }
}

async function runApprove(
  app: App,
  args: readonly string[],
  values: Values,
  io: CliIo,
): Promise<string> {
  const id = taskIdArg(args[0]);
  const task = app.tasks.get(null, id);
  if (task.status !== 'pending_approval') {
    throw new UabError(
      ErrorCode.TASK_STATE_INVALID,
      `Task ${id} is ${task.status}, not waiting for approval.`,
    );
  }
  if (values.yes === true) {
    // Non-interactive approval must name the exact hash the approver reviewed.
    const sha = required(values.sha256, '--sha256 (required with --yes)').toLowerCase();
    const approved = app.tasks.approve('cli', null, id, sha, values.note);
    return values.json === true
      ? json(approved)
      : `Approved ${id} (version ${String(approved.version)}).\n`;
  }
  io.stdout(formatApprovalRequest(task));
  if (io.readLine === undefined) {
    throw usage(
      `Not an interactive terminal. Review the prompt above, then run: uab approve ${id} --sha256 ${task.promptSha256} --yes`,
    );
  }
  const answer = (
    await io.readLine(`Approve this exact prompt for ${task.agentId}? Type "yes" to approve: `)
  )
    .trim()
    .toLowerCase();
  if (answer !== 'yes') return 'Not approved. Nothing was changed.\n';
  // Bound to the hash that was displayed: a revision made meanwhile makes this fail.
  const approved = app.tasks.approve('cli', null, id, task.promptSha256, values.note);
  return `Approved ${id} (version ${String(approved.version)}). ChatGPT can now dispatch it, or run: uab task run ${id}\n`;
}

async function runTask(
  app: App,
  args: readonly string[],
  values: Values,
  io: CliIo,
): Promise<string> {
  const [sub, arg] = args;
  switch (sub) {
    case 'show': {
      const t = app.tasks.get(null, taskIdArg(arg));
      return values.json === true ? json(t) : formatTaskDetails(t);
    }
    case 'run': {
      const t = app.tasks.get(null, taskIdArg(arg));
      const ctx = app.sessionAdmin.context(t.sessionId);
      app.executions.recover();
      const info = app.executions.dispatch('cli', ctx, t.taskId);
      io.stderr(
        `Running ${t.taskId} with ${t.agentId} (${info.executionId}). Press Ctrl+C to cancel.\n`,
      );
      const onSignal = () => {
        app.executions.cancel('cli', null, t.taskId);
      };
      process.once('SIGINT', onSignal);
      try {
        await app.executions.wait(info.executionId);
      } finally {
        process.removeListener('SIGINT', onSignal);
      }
      const result = app.executions.result(null, t.taskId);
      if (result === null) return `Task ${t.taskId}: ${app.tasks.get(null, t.taskId).status}\n`;
      return values.json === true ? json(result) : formatResult(result);
    }
    case 'result': {
      const id = taskIdArg(arg);
      const result = app.executions.result(null, id);
      if (result === null)
        return `No result for ${id} (status: ${app.tasks.get(null, id).status}).\n`;
      return values.json === true ? json(result) : formatResult(result);
    }
    case 'logs': {
      const page = app.executions.logs(null, taskIdArg(arg), {
        cursor: values.cursor === undefined ? undefined : Number(values.cursor),
        limit: limitOf(values, 200),
        maxBytes: 1024 * 1024,
      });
      if (values.json === true) return json(page);
      return (
        page.lines.map((l) => `[${l.stream}] ${l.text}`).join('\n') +
        (page.nextCursor === null ? '\n' : `\n(more: --cursor ${String(page.nextCursor)})\n`)
      );
    }
    case 'cancel': {
      const r = app.executions.cancel('cli', null, taskIdArg(arg));
      return values.json === true ? json(r) : `${r.taskId}: ${r.status}\n`;
    }
    default:
      throw usage(`Unknown task command: ${sub ?? '(none)'}`);
  }
}

/** Runs the CLI and returns the process exit code. Writes only through `io`. */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
  options: AppOptions = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        json: { type: 'boolean' },
        name: { type: 'string' },
        project: { type: 'string' },
        agent: { type: 'string' },
        title: { type: 'string' },
        all: { type: 'boolean' },
        cursor: { type: 'string' },
        limit: { type: 'string' },
        sha256: { type: 'string' },
        yes: { type: 'boolean' },
        reason: { type: 'string' },
        note: { type: 'string' },
        session: { type: 'string' },
        status: { type: 'string' },
        'uab-home': { type: 'string' },
      },
    });
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    return 2;
  }

  const values = parsed.values as Values & { help?: boolean; version?: boolean };
  const [command, ...rest] = parsed.positionals;

  if (values.version === true) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (values.help === true || command === undefined || command === 'help') {
    io.stdout(HELP);
    return 0;
  }

  let app: App | undefined;
  try {
    switch (command) {
      case 'mcp':
        await runMcpStdio(options);
        return 0;
      case 'mcp-config': {
        const home = values['uab-home'];
        if (home !== undefined && !path.isAbsolute(home))
          throw usage('--uab-home must be an absolute path.');
        io.stdout(
          [
            `# Add this to ${codexConfigPath(options.homedir, options.env ?? process.env)}`,
            '# (the MCP configuration shared by the ChatGPT desktop app and Codex), then restart the ChatGPT app.',
            mcpConfigToml({ ...(home === undefined ? {} : { uabHome: home }) }),
          ].join('\n'),
        );
        return 0;
      }
      case 'config': {
        const loaded = await loadConfig(options);
        if (values.json === true) {
          io.stdout(json(loaded));
        } else {
          io.stdout(
            [
              `Data directory: ${loaded.dataDir}`,
              `Config file:    ${loaded.configPath}${loaded.fromFile ? '' : ' (not found, using defaults)'}`,
              'Settings:',
              JSON.stringify(loaded.config, null, 2),
              '',
            ].join('\n'),
          );
        }
        return 0;
      }
      case 'project':
      case 'session':
      case 'db':
        app = await openApp(options);
        io.stdout(
          (command === 'project' ? runProject : command === 'session' ? runSession : runDb)(
            app,
            rest,
            values,
          ),
        );
        return 0;
      case 'agents':
        app = await openApp(options);
        io.stdout(await runAgents(app, rest, values, options));
        return 0;
      case 'pending': {
        app = await openApp(options);
        const pending = app.tasks.pending(null);
        io.stdout(
          values.json === true
            ? json(pending)
            : pending.length === 0
              ? 'Nothing is waiting for approval.\n'
              : formatTaskList(pending) + '\nReview one with: uab approve <task-id>\n',
        );
        return 0;
      }
      case 'approve':
        app = await openApp(options);
        io.stdout(await runApprove(app, rest, values, io));
        return 0;
      case 'reject': {
        app = await openApp(options);
        const t = app.tasks.reject('cli', null, taskIdArg(rest[0]), values.reason);
        io.stdout(values.json === true ? json(t) : `Rejected ${t.taskId}. It can never run.\n`);
        return 0;
      }
      case 'request-changes': {
        app = await openApp(options);
        const t = app.tasks.requestChanges(
          'cli',
          null,
          taskIdArg(rest[0]),
          required(values.note, '--note'),
        );
        io.stdout(
          values.json === true
            ? json(t)
            : `${t.taskId} sent back for changes. ChatGPT can revise it with revise_task_prompt.\n`,
        );
        return 0;
      }
      case 'tasks': {
        app = await openApp(options);
        const ctx = values.session === undefined ? null : app.sessionAdmin.context(values.session);
        const page = app.tasks.list(ctx, {
          limit: limitOf(values, 20),
          ...(values.status === undefined ? {} : { status: values.status }),
        });
        io.stdout(values.json === true ? json(page) : formatTaskList(page.tasks));
        return 0;
      }
      case 'task':
        app = await openApp(options);
        io.stdout(await runTask(app, rest, values, io));
        return 0;
      case 'audit': {
        app = await openApp(options);
        const events = app.tasks.auditLog(limitOf(values, 50));
        io.stdout(
          values.json === true
            ? json(events)
            : events
                .map(
                  (e) =>
                    `${String(e.id).padStart(5)}  ${e.ts}  ${e.actor.padEnd(6)}  ${e.action.padEnd(22)}  ${e.taskId ?? e.sessionId ?? ''}`,
                )
                .join('\n') + '\n',
        );
        return 0;
      }
      default:
        throw usage(`Unknown command: ${command}`);
    }
  } catch (error) {
    const payload = toErrorPayload(error);
    const details = payload.details;
    const extra: string[] = [];
    if (details !== undefined) {
      if (Array.isArray(details.issues))
        extra.push(...(details.issues as unknown[]).map((i) => `  - ${String(i)}`));
      if (typeof details.reason === 'string') extra.push(`  reason: ${details.reason}`);
      if (typeof details.hint === 'string') extra.push(`  ${details.hint}`);
      if (typeof details.problem === 'string') extra.push(`  ${details.problem}`);
    }
    io.stderr(
      `Error [${payload.code}]: ${payload.message}\n${extra.map((l) => l + '\n').join('')}`,
    );
    return payload.code === ErrorCode.INVALID_ARGUMENT ? 2 : 1;
  } finally {
    if (app !== undefined) {
      await app.executions.shutdown();
      app.close();
    }
  }
}
