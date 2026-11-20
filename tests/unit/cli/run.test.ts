import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../../../src/cli/run.js';
import { VERSION } from '../../../src/core/version.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

describe('runCli', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'uab-cli-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints the version', async () => {
    const c = capture();
    expect(await runCli(['--version'], c.io)).toBe(0);
    expect(c.out()).toBe(`${VERSION}\n`);
  });

  it.each([[[]], [['help']], [['--help']], [['-h']]])('prints help for %j', async (argv) => {
    const c = capture();
    expect(await runCli(argv, c.io)).toBe(0);
    expect(c.out()).toContain('Usage:');
    expect(c.err()).toBe('');
  });

  it('only lists commands that exist in this phase', async () => {
    const c = capture();
    await runCli(['help'], c.io);
    expect(c.out()).toMatch(/^\s+session create /m);
    expect(c.out()).toMatch(/^\s+project add /m);
    expect(c.out()).not.toMatch(/^\s+(approve|reject|mcp|dispatch)\b/m);
  });

  it('returns 2 for an unknown command', async () => {
    const c = capture();
    expect(await runCli(['launch-rockets'], c.io)).toBe(2);
    expect(c.err()).toContain('INVALID_ARGUMENT');
  });

  it('returns 2 for an unknown option', async () => {
    const c = capture();
    expect(await runCli(['--yolo'], c.io)).toBe(2);
    expect(c.err()).toContain('--yolo');
  });

  it('shows resolved config as JSON', async () => {
    const c = capture();
    expect(await runCli(['config', '--json'], c.io, { env: { UAB_HOME: dir } })).toBe(0);
    const parsed = JSON.parse(c.out()) as { dataDir: string; config: { approval: unknown } };
    expect(parsed.dataDir).toBe(path.normalize(dir));
    expect(parsed.config.approval).toEqual({ channel: 'local', expiryMinutes: 60 });
  });

  it('shows resolved config as text', async () => {
    const c = capture();
    expect(await runCli(['config'], c.io, { env: { UAB_HOME: dir } })).toBe(0);
    expect(c.out()).toContain('not found, using defaults');
  });

  it('reports validation issues and returns 1 for an invalid config file', async () => {
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ approval: { channel: 'auto' } }));
    const c = capture();
    expect(await runCli(['config'], c.io, { env: { UAB_HOME: dir } })).toBe(1);
    expect(c.err()).toContain('CONFIG_INVALID');
    expect(c.err()).toContain('approval.channel');
  });
});
