import { describe, expect, it } from 'vitest';
import { ErrorCode, UabError, isUabError, toErrorPayload } from '../../../src/core/errors.js';

describe('UabError', () => {
  it('keeps code, message, details and cause', () => {
    const cause = new Error('low level');
    const error = new UabError(ErrorCode.SESSION_NOT_FOUND, 'Session not found.', {
      details: { sessionId: 'UAB-x' },
      cause,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('UabError');
    expect(error.code).toBe('SESSION_NOT_FOUND');
    expect(error.details).toEqual({ sessionId: 'UAB-x' });
    expect(error.cause).toBe(cause);
  });

  it('isUabError matches by type and optional code', () => {
    const error = new UabError(ErrorCode.APPROVAL_EXPIRED, 'Expired.');
    expect(isUabError(error)).toBe(true);
    expect(isUabError(error, ErrorCode.APPROVAL_EXPIRED)).toBe(true);
    expect(isUabError(error, ErrorCode.APPROVAL_REQUIRED)).toBe(false);
    expect(isUabError(new Error('plain'))).toBe(false);
  });
});

describe('toErrorPayload', () => {
  it('returns code, message and details for UabError, without stack or cause', () => {
    const payload = toErrorPayload(
      new UabError(ErrorCode.CONFIG_INVALID, 'Bad config.', {
        details: { issues: ['x'] },
        cause: new Error('secret path C:\\Users\\someone'),
      }),
    );
    expect(payload).toEqual({
      code: 'CONFIG_INVALID',
      message: 'Bad config.',
      details: { issues: ['x'] },
    });
    expect(JSON.stringify(payload)).not.toContain('someone');
  });

  it('omits details when there are none', () => {
    expect(toErrorPayload(new UabError(ErrorCode.TASK_NOT_FOUND, 'No task.'))).toEqual({
      code: 'TASK_NOT_FOUND',
      message: 'No task.',
    });
  });

  it.each([new Error('token=abc123 at /home/user/.env'), 'a string', 42, null, undefined])(
    'hides unexpected errors behind INTERNAL_ERROR (%s)',
    (thrown) => {
      const payload = toErrorPayload(thrown);
      expect(payload).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred.',
      });
    },
  );
});

describe('ErrorCode', () => {
  it('uses each value as its own key, so codes stay stable when serialised', () => {
    for (const [key, value] of Object.entries(ErrorCode)) {
      expect(value).toBe(key);
    }
  });
});
