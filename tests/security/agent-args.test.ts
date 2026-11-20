import { describe, expect, it } from 'vitest';
import { BUILTIN_AGENTS } from '../../src/agents/adapters/builtin.js';
import { assertSafeArgs, findForbiddenArg } from '../../src/agents/args.js';

function def(id: string) {
  const d = BUILTIN_AGENTS.find((a) => a.id === id);
  if (d === undefined) throw new Error(id);
  return d;
}

/** Arguments that would weaken each agent's own permission checks. UAB must refuse them all. */
const DANGEROUS: Record<string, string[][]> = {
  kiro: [
    ['chat', '--trust-all-tools'],
    ['chat', '-a'],
    ['chat', '--trust-tools='],
    ['chat', '--trust-tools', ''],
    ['chat', '--trust-tools=*'],
    ['chat', '--trust-tools', 'fs_read,*'],
    ['chat', '--trust-tools=@builtin'],
    ['chat', '--trust-tools'],
  ],
  claude: [
    ['-p', '--dangerously-skip-permissions'],
    ['-p', '--allow-dangerously-skip-permissions'],
    ['-p', '--permission-mode', 'bypassPermissions'],
    ['-p', '--permission-mode=bypassPermissions'],
    ['-p', '--settings', '{"permissions":{"defaultMode":"bypassPermissions"}}'],
  ],
  opencode: [
    ['run', '--auto'],
    ['run', '--auto=true'],
  ],
  codex: [
    ['exec', '--sandbox', 'danger-full-access'],
    ['exec', '--sandbox=danger-full-access'],
    ['exec', '-s', 'danger-full-access'],
    ['exec', '--yolo'],
    ['exec', '--dangerously-bypass-approvals-and-sandbox'],
    ['exec', '-c', 'sandbox_mode="danger-full-access"'],
    ['exec', '--config=sandbox_mode=danger-full-access'],
  ],
};

/** Normal, safe arguments that must still be allowed. */
const SAFE: Record<string, string[][]> = {
  kiro: [
    ['chat', '--no-interactive', '--trust-tools=fs_read,grep', '--output-format', 'stream-json'],
  ],
  claude: [
    ['-p', '--permission-mode', 'dontAsk', '--output-format', 'stream-json'],
    ['-p', '--permission-mode', 'acceptEdits'],
  ],
  opencode: [['run', '--format', 'json', '--dir', '/repo']],
  codex: [
    ['exec', '--json', '--sandbox', 'workspace-write'],
    ['exec', '--sandbox', 'read-only'],
  ],
};

describe('forbidden agent arguments', () => {
  for (const [id, cases] of Object.entries(DANGEROUS)) {
    it.each(cases)(`${id}: refuses %j`, (...args) => {
      expect(() => {
        assertSafeArgs(id, args, def(id).forbiddenArgs);
      }).toThrow(expect.objectContaining({ code: 'FORBIDDEN_AGENT_ARGUMENT' }));
    });
  }

  for (const [id, cases] of Object.entries(SAFE)) {
    it.each(cases)(`${id}: allows %j`, (...args) => {
      expect(findForbiddenArg(args, def(id).forbiddenArgs)).toBeUndefined();
    });
  }

  it('treats text after `--` as prompt content, not flags', () => {
    expect(
      findForbiddenArg(
        ['-p', '--', 'explain --dangerously-skip-permissions'],
        def('claude').forbiddenArgs,
      ),
    ).toBeUndefined();
    expect(findForbiddenArg(['-p', '--', '--yolo'], def('codex').forbiddenArgs)).toBeUndefined();
  });

  it('does not match flags that merely share a prefix', () => {
    expect(findForbiddenArg(['--autosave'], def('opencode').forbiddenArgs)).toBeUndefined();
    expect(findForbiddenArg(['-abc'], def('kiro').forbiddenArgs)).toBeUndefined();
  });

  it('reports the flag and reason, not the argument values', () => {
    try {
      assertSafeArgs(
        'claude',
        ['--permission-mode', 'bypassPermissions'],
        def('claude').forbiddenArgs,
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ details: { agentId: 'claude', flag: '--permission-mode' } });
    }
  });

  it('no built-in probe uses a forbidden argument', () => {
    for (const d of BUILTIN_AGENTS) {
      for (const probe of [d.versionProbe, d.authProbe]) {
        expect(findForbiddenArg(probe.args, d.forbiddenArgs)).toBeUndefined();
      }
    }
  });
});
