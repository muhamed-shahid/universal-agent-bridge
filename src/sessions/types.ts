import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { crockfordPattern } from '../core/ids.js';
import { CONTROL_CHARS } from '../core/validation.js';

export type Actor = 'mcp' | 'cli' | 'system';
export type SessionStatus = 'active' | 'closed';

export const SESSION_ID_PATTERN = new RegExp(`^UAB-${crockfordPattern(12)}$`);
export const SESSION_TOKEN_PATTERN = /^uab_st_[A-Za-z0-9_-]{43}$/;

/** Credentials a ChatGPT conversation presents for every session-scoped call. */
export const sessionRefSchema = z.strictObject({
  sessionId: z.string().max(64),
  sessionToken: z.string().max(128),
});
export type SessionRef = z.infer<typeof sessionRefSchema>;

export const sessionTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((v) => !CONTROL_CHARS.test(v), 'must not contain control characters');

export interface SessionSummary {
  readonly sessionId: string;
  readonly title: string | null;
  readonly status: SessionStatus;
  readonly agentId: string;
  readonly projectName: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
}

export interface SessionAgentUsage {
  readonly agentId: string;
  readonly firstUsedAt: string;
  readonly lastUsedAt: string;
  /** Whether the agent has a native conversation for this session (set from Phase 4). */
  readonly hasNativeSession: boolean;
}

export interface SessionDetails extends SessionSummary {
  readonly project: { readonly id: string; readonly name: string; readonly path: string };
  readonly agents: readonly SessionAgentUsage[];
  readonly updatedAt: string;
  readonly closedAt: string | null;
  /** Other active sessions registered on the same project directory. */
  readonly otherActiveSessionsOnProject: number;
}

export interface SessionEvent {
  readonly id: number;
  readonly ts: string;
  readonly actor: Actor;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface SessionEventPage {
  readonly events: readonly SessionEvent[];
  /** Pass as `cursor` to get the next page; null when there are no more events. */
  readonly nextCursor: string | null;
}

export const historyQuerySchema = z.strictObject({
  cursor: z
    .string()
    .regex(/^\d{1,15}$/)
    .optional(),
  limit: z.int().min(1).max(100).default(50),
});
export type HistoryQuery = z.input<typeof historyQuerySchema>;

export function newSessionToken(random: (size: number) => Buffer = nodeRandomBytes): string {
  return `uab_st_${random(32).toString('base64url')}`;
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const DUMMY_HASH = hashSessionToken('uab_st_dummy');

/** Constant-time comparison of a presented token against a stored hash (or a dummy). */
export function tokenMatches(token: string, storedHash: string | undefined): boolean {
  const presented = Buffer.from(hashSessionToken(token), 'hex');
  const expected = Buffer.from(storedHash ?? DUMMY_HASH, 'hex');
  const equal = presented.length === expected.length && timingSafeEqual(presented, expected);
  return storedHash !== undefined && equal;
}
