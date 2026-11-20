import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildChildEnv } from '../../../src/execution/env.js';
import { runProcess, type RunRequest } from '../../../src/execution/process.js';
import { MOCK_CLI_SCRIPT } from '../../helpers/mock-cli.js';

function mock(args: string[], extra: Partial<RunRequest> = {}): RunRequest {
  return {
    command: process.execPath,
    args: [MOCK_CLI_SCRIPT, ...args],
    cwd: os.tmpdir(),
    env: buildChildEnv(process.env),
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    ...extra,
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(fn: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

describe('runProcess', () => {
  it('passes arguments verbatim, without a shell', async () => {
    const hostile = [
      'a b',
      '"quoted"',
      '$(whoami)',
      '`id`',
      '; rm -rf /',
      '& del *',
      '%PATH%',
      '|',
      '>out',
    ];
    const result = await runProcess(mock(['echo-args', ...hostile]));
    expect(result.outcome).toBe('exited');
    expect(JSON.parse(result.stdout)).toEqual(hostile);
  });

  it('sends stdin to the process', async () => {
    const prompt = 'Implement the feature.\nLine 2 with "quotes" & symbols | < >';
    const result = await runProcess(mock(['echo-stdin'], { stdin: prompt }));
    expect(JSON.parse(result.stdout)).toEqual({ stdin: prompt });
  });

  it('reports a non-zero exit code and stderr', async () => {
    const result = await runProcess(mock(['exit-code']));
    expect(result).toMatchObject({ outcome: 'exited', exitCode: 7, stderr: 'failure details\n' });
  });

  it('passes only the given environment', async () => {
    const result = await runProcess(mock(['echo-env'], { env: { ONLY_THIS: '1', PATH: '' } }));
    const names = JSON.parse(result.stdout) as string[];
    expect(names).toContain('ONLY_THIS');
    expect(names).not.toContain('UAB_SECRET_TEST');
  });

  it('caps output and marks it truncated', async () => {
    const result = await runProcess(mock(['huge'], { maxOutputBytes: 1000 }));
    expect(result.stdout).toHaveLength(1000);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
  });

  it('kills a process that exceeds the timeout', async () => {
    const result = await runProcess(mock(['hang'], { timeoutMs: 500 }));
    expect(result.outcome).toBe('timed_out');
    expect(result.durationMs).toBeLessThan(8000);
  });

  it('kills the whole process tree on timeout', async () => {
    const result = await runProcess(mock(['tree'], { timeoutMs: 1500 }));
    expect(result.outcome).toBe('timed_out');
    const grandchild = Number(result.stdout.trim());
    expect(grandchild).toBeGreaterThan(0);
    expect(await waitUntil(() => !isAlive(grandchild))).toBe(true);
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 300);
    const result = await runProcess(mock(['hang'], { signal: controller.signal }));
    expect(result.outcome).toBe('aborted');
  });

  it('reports spawn failures instead of throwing', async () => {
    const missing = path.join(
      os.tmpdir(),
      'definitely-missing-uab-binary' + (process.platform === 'win32' ? '.exe' : ''),
    );
    const result = await runProcess({ ...mock([]), command: missing, args: [] });
    expect(result.outcome).toBe('spawn_failed');
    expect(result.spawnError).toBe('ENOENT');
  });

  it.each([
    [{ command: 'node' }, 'command_not_absolute'],
    [{ cwd: 'relative' }, 'cwd_not_absolute'],
    [{ args: ['a\u0000b'] }, 'nul_byte'],
  ])('refuses unsafe requests %j', async (patch, reason) => {
    await expect(runProcess({ ...mock([]), ...patch })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { reason },
    });
  });

  it
    .runIf(process.platform === 'win32')
    .each(['C:\\x\\tool.cmd', 'C:\\x\\tool.BAT', 'C:\\x\\tool.ps1', 'C:\\x\\tool.js'])(
    'refuses Windows script files that need a shell (%s)',
    async (command) => {
      await expect(runProcess({ ...mock([]), command })).rejects.toMatchObject({
        details: { reason: 'shell_script' },
      });
    },
  );
});

describe('buildChildEnv', () => {
  it('keeps allowlisted and declared names only, and sets non-interactive defaults', () => {
    const env = buildChildEnv(
      {
        PATH: '/bin',
        HOME: '/h',
        AWS_SECRET_ACCESS_KEY: 'x',
        GITHUB_TOKEN: 'y',
        MY_KEY: 'z',
        UAB_HOME: '/u',
      },
      ['MY_KEY'],
      'linux',
    );
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/h',
      MY_KEY: 'z',
      NO_COLOR: '1',
      CI: '1',
      TERM: 'dumb',
    });
  });

  it('matches names case-insensitively on Windows and keeps the original spelling', () => {
    const env = buildChildEnv(
      { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', Secret: 's' },
      [],
      'win32',
    );
    expect(env.Path).toBe('C:\\bin');
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.Secret).toBeUndefined();
  });

  it('is case-sensitive on POSIX', () => {
    expect(buildChildEnv({ path: '/x' }, [], 'linux').path).toBeUndefined();
  });

  it('ignores invalid declared names', () => {
    expect(Object.keys(buildChildEnv({ 'A=B': '1' }, ['A=B'], 'linux'))).not.toContain('A=B');
  });
});
