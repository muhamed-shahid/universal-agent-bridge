/**
 * Error codes returned by UAB. They are part of the public MCP contract: ChatGPT and scripts
 * branch on `code`, so existing codes must not be renamed.
 */
export const ErrorCode = {
  // Configuration and startup
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_NOT_READABLE: 'CONFIG_NOT_READABLE',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  // Sessions and projects (Phase 2)
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_CLOSED: 'SESSION_CLOSED',
  PROJECT_PATH_INVALID: 'PROJECT_PATH_INVALID',
  PATH_OUTSIDE_PROJECT: 'PATH_OUTSIDE_PROJECT',
  // Agents (Phase 3 onwards)
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  AGENT_NOT_INSTALLED: 'AGENT_NOT_INSTALLED',
  AGENT_NOT_AUTHENTICATED: 'AGENT_NOT_AUTHENTICATED',
  // Tasks and approvals (Phase 5)
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  TASK_STATE_INVALID: 'TASK_STATE_INVALID',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  APPROVAL_MISMATCH: 'APPROVAL_MISMATCH',
  APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
  APPROVAL_ALREADY_USED: 'APPROVAL_ALREADY_USED',
  APPROVAL_CHANNEL_LOCAL_ONLY: 'APPROVAL_CHANNEL_LOCAL_ONLY',
  // Execution (Phase 6)
  WORKTREE_BUSY: 'WORKTREE_BUSY',
  EXECUTION_TIMEOUT: 'EXECUTION_TIMEOUT',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  // Fallback
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export type ErrorDetails = Readonly<Record<string, unknown>>;

/** An expected, user-facing failure with a stable code. */
export class UabError extends Error {
  override readonly name = 'UabError';
  readonly code: ErrorCode;
  readonly details: ErrorDetails | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: ErrorDetails; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.details = options.details;
  }
}

export interface ErrorPayload {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: ErrorDetails;
}

/**
 * Converts any thrown value into a payload that is safe to return to a client.
 * Unexpected errors are reduced to INTERNAL_ERROR so stack traces, file paths and causes
 * never leak through MCP responses. Log the original error separately (to stderr).
 */
export function toErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof UabError) {
    return error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details };
  }
  return { code: ErrorCode.INTERNAL_ERROR, message: 'An internal error occurred.' };
}

export function isUabError(error: unknown, code?: ErrorCode): error is UabError {
  return error instanceof UabError && (code === undefined || error.code === code);
}
