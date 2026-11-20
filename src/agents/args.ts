import { ErrorCode, UabError } from '../core/errors.js';
import type { ForbiddenArg } from './types.js';

export interface ForbiddenMatch {
  readonly flag: string;
  readonly index: number;
  readonly reason: string;
}

function valueIsForbidden(rule: ForbiddenArg, value: string | undefined): boolean {
  if (rule.values === undefined && rule.valuePattern === undefined) return true;
  const v = (value ?? '').trim();
  if (rule.values?.includes(v) === true) return true;
  return value !== undefined && rule.valuePattern?.test(value) === true;
}

/**
 * Finds the first forbidden argument. Recognises `--flag`, `--flag=value` and
 * `--flag value`. Short flags are listed explicitly by adapters (for example Kiro's `-a`).
 * Arguments after a literal `--` are positional (prompt text) and are not flags.
 */
export function findForbiddenArg(
  args: readonly string[],
  forbidden: readonly ForbiddenArg[],
): ForbiddenMatch | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--') return undefined;
    for (const rule of forbidden) {
      let value: string | undefined;
      if (arg === rule.flag) {
        value = args[i + 1];
      } else if (arg.startsWith(`${rule.flag}=`)) {
        value = arg.slice(rule.flag.length + 1);
      } else {
        continue;
      }
      if (valueIsForbidden(rule, value)) {
        return { flag: rule.flag, index: i, reason: rule.reason };
      }
    }
  }
  return undefined;
}

/** Throws if any argument would weaken the agent's native permission checks. */
export function assertSafeArgs(
  agentId: string,
  args: readonly string[],
  forbidden: readonly ForbiddenArg[],
): void {
  const match = findForbiddenArg(args, forbidden);
  if (match !== undefined) {
    throw new UabError(
      ErrorCode.FORBIDDEN_AGENT_ARGUMENT,
      "UAB never passes arguments that weaken an agent's own permission checks.",
      { details: { agentId, flag: match.flag, reason: match.reason } },
    );
  }
}
