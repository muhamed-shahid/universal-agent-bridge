/**
 * Agent ids UAB knows about. Phase 3 replaces this list with the agent registry; until then
 * sessions can only be bound to these ids. Ids are stable public identifiers.
 */
export const KNOWN_AGENT_IDS = ['kiro', 'claude', 'opencode', 'codex'] as const;

export type KnownAgentId = (typeof KNOWN_AGENT_IDS)[number];

export const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export function isKnownAgentId(id: string): boolean {
  return (KNOWN_AGENT_IDS as readonly string[]).includes(id);
}
