import { describe, expect, it } from 'vitest';
import { randomId } from '../../../src/core/ids.js';
import { parseInput } from '../../../src/core/validation.js';
import { z } from 'zod';
import {
  SESSION_ID_PATTERN,
  SESSION_TOKEN_PATTERN,
  hashSessionToken,
  newSessionToken,
  tokenMatches,
} from '../../../src/sessions/types.js';

describe('randomId', () => {
  it('uses Crockford base32 with the requested length', () => {
    const id = randomId('UAB-', 12);
    expect(id).toMatch(SESSION_ID_PATTERN);
  });

  it('maps bytes deterministically and never emits ambiguous letters', () => {
    const all = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    const id = randomId('', 32, () => all);
    expect(id).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
    expect(id).not.toMatch(/[ILOU]/);
  });
});

describe('session tokens', () => {
  it('have 256 bits of randomness in a fixed format', () => {
    const token = newSessionToken();
    expect(token).toMatch(SESSION_TOKEN_PATTERN);
    expect(new Set(Array.from({ length: 100 }, () => newSessionToken())).size).toBe(100);
  });

  it('match only their own hash', () => {
    const token = newSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenMatches(token, hash)).toBe(true);
    expect(tokenMatches(newSessionToken(), hash)).toBe(false);
    expect(tokenMatches(token, undefined)).toBe(false);
    expect(tokenMatches('uab_st_dummy', undefined)).toBe(false);
  });
});

describe('parseInput', () => {
  it('reports issue paths without echoing the rejected value', () => {
    try {
      parseInput(z.strictObject({ name: z.string().max(3) }), { name: 'secret-value' }, 'thing');
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'Invalid thing.' });
      expect(JSON.stringify((error as { details: unknown }).details)).not.toContain('secret-value');
    }
  });
});
