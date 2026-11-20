import { describe, expect, it } from 'vitest';
import {
  BUILTIN_AGENTS,
  parseClaudeAuth,
  parseCodexAuth,
  parseKiroAuth,
  parseOpenCodeAuth,
} from '../../../src/agents/adapters/builtin.js';
import { parseSemver, stripAnsi, type ProbeOutput } from '../../../src/agents/types.js';

const ok = (stdout: string, stderr = ''): ProbeOutput => ({ exitCode: 0, stdout, stderr });
const fail = (code: number, stdout = '', stderr = ''): ProbeOutput => ({
  exitCode: code,
  stdout,
  stderr,
});

/** Fake values that must never appear in any parsed result. */
const SECRETS = [
  'someone@example.com',
  'sk-ant-fake-0000',
  'https://proxy.example.com',
  'd-0000000000',
  'arn:aws:fake',
];
const noSecrets = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const s of SECRETS) expect(text).not.toContain(s);
};

describe('parseSemver', () => {
  it.each([
    ['kiro-cli-chat 2.27.1\n', '2.27.1'],
    ['2.1.220 (Claude Code)\n', '2.1.220'],
    ['1.19.3\n', '1.19.3'],
    ['codex-cli 0.171.0-alpha.2\n', '0.171.0-alpha.2'],
  ])('reads %j', (stdout, version) => {
    expect(parseSemver(ok(stdout))).toBe(version);
  });

  it('returns undefined for failures and output without a version', () => {
    expect(parseSemver(fail(1, '1.2.3'))).toBeUndefined();
    expect(parseSemver(ok('unknown'))).toBeUndefined();
  });
});

describe('Kiro CLI auth', () => {
  it('reads the account type from whoami JSON and drops everything else', () => {
    const stdout =
      '{"accountType":"IamIdentityCenter","startUrl":"https://d-0000000000.awsapps.com/start","region":"us-east-1","email":"someone@example.com"}\n\nProfile:\nKiroProfile-us-east-1\narn:aws:fake\n';
    const result = parseKiroAuth(ok(stdout));
    expect(result).toEqual({ state: 'authenticated', method: 'IamIdentityCenter' });
    noSecrets(result);
  });

  it.each([fail(1, '', 'Not logged in. Run kiro-cli login'), fail(1, 'You are not signed in')])(
    'detects a logged-out CLI',
    (output) => {
      expect(parseKiroAuth(output).state).toBe('not_authenticated');
    },
  );

  it('is unknown for unexpected output', () => {
    expect(parseKiroAuth(ok('???')).state).toBe('unknown');
    expect(parseKiroAuth(ok('{"foo":1}')).state).toBe('unknown');
  });
});

describe('Claude Code auth', () => {
  it('reads loggedIn and authMethod only', () => {
    const result = parseClaudeAuth(
      ok(
        '{"loggedIn":true,"authMethod":"api_key_helper","apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY","email":"someone@example.com"}',
      ),
    );
    expect(result).toEqual({ state: 'authenticated', method: 'api_key_helper' });
    noSecrets(result);
  });

  it('drops an auth method that is not a plain label', () => {
    expect(parseClaudeAuth(ok('{"loggedIn":true,"authMethod":"key=sk-ant-fake-0000"}'))).toEqual({
      state: 'authenticated',
    });
  });

  it('detects logged out, including a non-zero exit code', () => {
    expect(parseClaudeAuth(fail(1, '{"loggedIn":false}')).state).toBe('not_authenticated');
  });

  it('is unknown for text output (which contains the base URL) or garbage', () => {
    const text =
      'Auth token: apiKeyHelper\nAPI key: ANTHROPIC_API_KEY\nAnthropic base URL: https://proxy.example.com\n';
    const result = parseClaudeAuth(ok(text));
    expect(result.state).toBe('unknown');
    noSecrets(result);
    expect(parseClaudeAuth(ok('{"loggedIn":"yes"}')).state).toBe('unknown');
  });
});

describe('OpenCode auth', () => {
  const real =
    '\u001b[0m\n\u001b[90mT\u001b[39m  Credentials \u001b[90m~\\.local\\share\\opencode\\auth.json\n\u001b[90m|\u001b[39m\n\u001b[34m•\u001b[39m  Amazon Bedrock \u001b[90mapi\n\u001b[90m|\u001b[39m\n\u001b[34m•\u001b[39m  OpenCode \u001b[90mapi\n\u001b[90m|\u001b[39m\n\u001b[90m—\u001b[39m  2 credentials\n';

  it('counts stored credentials in real coloured output', () => {
    expect(parseOpenCodeAuth(ok(real))).toEqual({
      state: 'authenticated',
      method: 'stored_credentials',
      detail: '2 stored provider credential(s).',
    });
  });

  it('reports zero credentials as not authenticated, and failures as unknown', () => {
    expect(parseOpenCodeAuth(ok('—  0 credentials')).state).toBe('not_authenticated');
    expect(parseOpenCodeAuth(ok('—  1 credential')).state).toBe('authenticated');
    expect(parseOpenCodeAuth(fail(1, '2 credentials')).state).toBe('unknown');
    expect(parseOpenCodeAuth(ok('nothing useful')).state).toBe('unknown');
  });

  it('never returns provider names', () => {
    expect(JSON.stringify(parseOpenCodeAuth(ok(real)))).not.toMatch(/Bedrock|auth\.json/);
  });
});

describe('Codex CLI auth (documentation-based)', () => {
  it.each([
    [ok('Logged in using ChatGPT\n'), { state: 'authenticated', method: 'chatgpt' }],
    [
      ok('', 'Logged in using an API key - sk-proj-***ABCD\n'),
      { state: 'authenticated', method: 'api_key' },
    ],
    [fail(1, 'Not logged in\n'), { state: 'not_authenticated' }],
    [ok('Not logged in\n'), { state: 'not_authenticated' }],
  ])('parses %j', (output, expected) => {
    const result = parseCodexAuth(output);
    expect(result).toMatchObject(expected);
    expect(JSON.stringify(result)).not.toContain('sk-proj');
  });

  it('is unknown for unexpected output', () => {
    expect(parseCodexAuth(ok('error: unexpected argument')).state).toBe('unknown');
  });
});

describe('built-in definitions', () => {
  it('cover the four supported agents with unique ids', () => {
    expect(BUILTIN_AGENTS.map((d) => d.id)).toEqual(['kiro', 'claude', 'opencode', 'codex']);
  });

  it('give install, login and documentation guidance for every agent', () => {
    for (const d of BUILTIN_AGENTS) {
      expect(d.instructions.install.length).toBeGreaterThan(0);
      expect(d.instructions.authenticate.length).toBeGreaterThan(0);
      expect(d.instructions.docsUrl).toMatch(/^https:\/\//);
    }
  });

  it('do not claim task execution yet (Phase 4+)', () => {
    expect(BUILTIN_AGENTS.every((d) => d.execution === undefined)).toBe(true);
  });

  it('only use read-only status commands as probes', () => {
    const allowed = new Set([
      '--version',
      'whoami -f json',
      'auth status --json',
      'providers list',
      'login status',
    ]);
    for (const d of BUILTIN_AGENTS) {
      expect(allowed.has(d.versionProbe.args.join(' '))).toBe(true);
      expect(allowed.has(d.authProbe.args.join(' '))).toBe(true);
    }
  });
});

describe('stripAnsi', () => {
  it('removes colour and OSC sequences', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m \u001b]0;title\u0007ok')).toBe('red ok');
  });
});
