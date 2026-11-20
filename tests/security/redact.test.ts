import { describe, expect, it } from 'vitest';
import { REDACTED, Redactor, isSensitivePath } from '../../src/security/redact.js';

describe('Redactor', () => {
  const r = new Redactor({
    MY_API_TOKEN: 'tok-env-value-9876',
    PATH: '/usr/bin:/bin',
    SHORT_KEY: 'abc',
  });

  it.each([
    ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz'],
    ['sk-proj-ABCDEFGHIJKLMNOPQRSTUV12'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'],
    ['xoxb-1234567890-abcdefghij'],
    ['AKIAABCDEFGHIJKLMNOP'],
    ['AIzaSyA1234567890abcdefghijklmnopqrstuv'],
    [
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ],
    ['uab_st_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'],
    ['npm_abcdefghijklmnopqrstuvwxyz0123456789'],
  ])('redacts %s', (secret) => {
    const out = r.redact(`before ${secret} after`);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
    expect(out).toMatch(/^before .* after$/);
  });

  it('redacts private keys, bearer tokens, URL credentials and secret assignments', () => {
    const text = [
      '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2E\n-----END OPENSSH PRIVATE KEY-----',
      'Authorization: Bearer abcdefghijklmnop.qrstuv',
      'https://user:hunter2@example.com/repo.git',
      'DB_PASSWORD=correct-horse-battery',
      'api_key: "zyxw9876"',
      '"clientSecret": "s3cr3tvalue"',
    ].join('\n');
    const out = r.redact(text);
    for (const s of [
      'AAAAB3NzaC1yc2E',
      'abcdefghijklmnop.qrstuv',
      'hunter2',
      'correct-horse-battery',
      'zyxw9876',
      's3cr3tvalue',
    ]) {
      expect(out).not.toContain(s);
    }
    expect(out).toContain('DB_PASSWORD=');
    expect(out).toContain('https://[REDACTED]@example.com');
  });

  it('redacts values of secret-looking environment variables, but not short or non-secret ones', () => {
    expect(r.redact('value tok-env-value-9876 here')).toBe(`value ${REDACTED} here`);
    expect(r.redact('/usr/bin:/bin')).toBe('/usr/bin:/bin');
    expect(r.redact('abc')).toBe('abc');
  });

  it('leaves ordinary code alone', () => {
    const code =
      'const tokenizer = new Tokenizer();\nfunction getAuthor() { return author; }\nconst password = process.env.PASSWORD;';
    expect(r.redact(code)).toBe(code);
  });
});

describe('isSensitivePath', () => {
  it.each([
    '.env',
    '.env.local',
    'config/.env.production',
    'certs/server.pem',
    'id_rsa',
    '.ssh/config',
    '.npmrc',
    'secrets.json',
    '.aws/credentials',
    'deploy/key.p12',
  ])('flags %s', (p) => {
    expect(isSensitivePath(p)).toBe(true);
  });
  it.each(['.env.example', 'src/env.ts', 'README.md', 'docs/secrets-handling.md', 'keyboard.ts'])(
    'allows %s',
    (p) => {
      expect(isSensitivePath(p)).toBe(false);
    },
  );
});
