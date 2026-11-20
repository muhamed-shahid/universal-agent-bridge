import { parseArgs } from 'node:util';
import { loadConfig, type LoadConfigOptions } from '../core/config.js';
import { ErrorCode, UabError, toErrorPayload } from '../core/errors.js';
import { VERSION } from '../core/version.js';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const HELP = `Universal Agent Bridge (uab) ${VERSION}

Usage:
  uab <command> [options]

Commands:
  config     Show the resolved data directory, config file and settings
  help       Show this help

Options:
  -h, --help     Show help
  -v, --version  Show version
      --json     Machine-readable output (config)

Environment:
  UAB_HOME       Absolute path of the data directory
  UAB_CONFIG     Absolute path of the JSON config file
  UAB_LOG_LEVEL  debug | info | warn | error

This is an early development build. Session, approval and MCP commands are not
available yet. See docs/architecture.md for the phase plan.
`;

/** Runs the CLI and returns the process exit code. Has no side effects beyond `io`. */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
  configOptions: LoadConfigOptions = {},
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
      },
    });
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    return 2;
  }

  const { values, positionals } = parsed;
  const command = positionals[0];

  if (values.version === true) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (values.help === true || command === undefined || command === 'help') {
    io.stdout(HELP);
    return 0;
  }

  try {
    switch (command) {
      case 'config': {
        const loaded = await loadConfig(configOptions);
        if (values.json === true) {
          io.stdout(JSON.stringify(loaded, null, 2) + '\n');
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
      default:
        throw new UabError(ErrorCode.INVALID_ARGUMENT, `Unknown command: ${command}`);
    }
  } catch (error) {
    const payload = toErrorPayload(error);
    const issues =
      payload.details !== undefined && Array.isArray(payload.details.issues)
        ? (payload.details.issues as unknown[]).map((i) => `  - ${String(i)}`).join('\n') + '\n'
        : '';
    io.stderr(`Error [${payload.code}]: ${payload.message}\n${issues}`);
    return payload.code === ErrorCode.INVALID_ARGUMENT ? 2 : 1;
  }
}
