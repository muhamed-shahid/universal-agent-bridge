import path from 'node:path';
import { parseArgs } from 'node:util';
import { openApp, type App, type AppOptions } from '../app.js';
import { loadConfig } from '../core/config.js';
import { ErrorCode, UabError, toErrorPayload } from '../core/errors.js';
import { VERSION } from '../core/version.js';
import { currentSchemaVersion, MIGRATIONS } from '../database/index.js';
import {
  formatAgentList,
  formatAgentStatus,
  formatHistory,
  formatProjects,
  formatSession,
  formatSessionList,
  formatToken,
} from './format.js';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const HELP = `Universal Agent Bridge (uab) ${VERSION}

Usage:
  uab <command> [options]

Commands:
  config                                Show the resolved data directory and settings
  project add <path> [--name <name>]    Register a project directory (absolute path)
  project list                          List registered projects
  project remove <project-id>           Remove a project that has no sessions
  session create --project <path|id> --agent <agent> [--title <title>]
                                        Create a session and print its token once
  session list [--all]                  List active sessions (--all includes closed)
  session show <session-id>             Show a session
  session history <session-id> [--cursor <n>] [--limit <n>]
                                        Show a session's event history
  session close <session-id>            Close a session
  session rotate-token <session-id>     Issue a new token; the old one stops working
  agents list                           List the coding agents UAB knows about
  agents status [<agent>]               Detect installed agents, versions and login status
  db status                             Show the database file and schema version
  db backup <absolute-file>             Write a consistent copy of the database
  help                                  Show this help

Options:
  -h, --help     Show help
  -v, --version  Show version
      --json     Machine-readable output

Agents: kiro (Kiro CLI), claude (Claude Code), opencode (OpenCode), codex (Codex CLI)

Environment:
  UAB_HOME       Absolute path of the data directory
  UAB_CONFIG     Absolute path of the JSON config file
  UAB_LOG_LEVEL  debug | info | warn | error

Early development build: the MCP server, approvals and agent execution are not
available yet. See docs/architecture.md for the phase plan.
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

function historyQuery(values: Values): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  if (values.cursor !== undefined) query.cursor = values.cursor;
  if (values.limit !== undefined) query.limit = Number(values.limit);
  return query;
}

function runProject(app: App, args: readonly string[], values: Values): string {
  const [sub, arg] = args;
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
      return values.json === true ? json(projects) : formatProjects(projects);
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

async function runAgents(app: App, args: readonly string[], values: Values): Promise<string> {
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
      },
    });
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    return 2;
  }

  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;

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
      case 'agents':
      case 'db': {
        app = await openApp(options);
        const handlers = { project: runProject, session: runSession, agents: runAgents, db: runDb };
        io.stdout(await handlers[command](app, rest, values));
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
      if (Array.isArray(details.issues)) {
        extra.push(...(details.issues as unknown[]).map((i) => `  - ${String(i)}`));
      }
      if (typeof details.reason === 'string') extra.push(`  reason: ${details.reason}`);
      if (typeof details.hint === 'string') extra.push(`  ${details.hint}`);
    }
    io.stderr(
      `Error [${payload.code}]: ${payload.message}\n${extra.map((l) => l + '\n').join('')}`,
    );
    return payload.code === ErrorCode.INVALID_ARGUMENT ? 2 : 1;
  } finally {
    app?.close();
  }
}
