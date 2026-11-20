import type { z } from 'zod';
import { ErrorCode, UabError } from './errors.js';

/** Turns Zod issues into short `path: message` strings. Input values are never echoed. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${where}: ${issue.message}`;
  });
}

/** Validates untrusted input. Throws INVALID_ARGUMENT with the list of issues on failure. */
export function parseInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
  what: string,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new UabError(ErrorCode.INVALID_ARGUMENT, `Invalid ${what}.`, {
      details: { issues: formatIssues(result.error) },
    });
  }
  return result.data;
}

/** Matches ASCII control characters, including NUL. */
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose.
export const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
