import type { LogLevel } from './config.js';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  /** Where log lines go. Defaults to stderr. Never stdout: stdout carries MCP JSON-RPC. */
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
}

/**
 * Minimal JSON-lines logger that writes to stderr.
 * Secret redaction of log fields is added with the security module (Phase 6); until then,
 * callers must not pass prompts, agent output or environment values as fields.
 */
export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? ((line: string) => process.stderr.write(line + '\n'));
  const now = options.now ?? (() => new Date());
  const threshold = ORDER[options.level];

  const log = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (ORDER[level] < threshold) return;
    write(JSON.stringify({ ts: now().toISOString(), level, msg: message, ...fields }));
  };

  return {
    debug: (m, f) => {
      log('debug', m, f);
    },
    info: (m, f) => {
      log('info', m, f);
    },
    warn: (m, f) => {
      log('warn', m, f);
    },
    error: (m, f) => {
      log('error', m, f);
    },
  };
}
