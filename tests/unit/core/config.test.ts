import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configSchema, loadConfig, parseConfig } from '../../../src/core/config.js';
import { UabError } from '../../../src/core/errors.js';

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof UabError && error.code === 'CONFIG_INVALID') {
      return (error.details?.issues as string[] | undefined) ?? [];
    }
    throw error;
  }
  throw new Error('expected CONFIG_INVALID');
}

describe('parseConfig', () => {
  it('returns safe defaults for an empty config', () => {
    expect(parseConfig(undefined)).toEqual({
      logLevel: 'info',
      approval: { channel: 'local', expiryMinutes: 60 },
      execution: { timeoutMinutes: 30, verifyTimeoutMinutes: 10, maxOutputBytes: 2 * 1024 * 1024 },
      mcp: { maxResponseBytes: 64 * 1024 },
      projects: { allowMcpRegistration: false },
      agents: {},
    });
  });

  it('defaults to the local (out-of-band) approval channel', () => {
    expect(parseConfig({}).approval.channel).toBe('local');
    expect(parseConfig({ approval: {} }).approval.channel).toBe('local');
  });

  it('accepts valid overrides', () => {
    const config = parseConfig({
      logLevel: 'debug',
      approval: { channel: 'chat', expiryMinutes: 15 },
      execution: { timeoutMinutes: 90 },
    });
    expect(config.logLevel).toBe('debug');
    expect(config.approval).toEqual({ channel: 'chat', expiryMinutes: 15 });
    expect(config.execution.timeoutMinutes).toBe(90);
    expect(config.execution.maxOutputBytes).toBe(2 * 1024 * 1024);
  });

  it('rejects unknown keys, including misspelt security settings', () => {
    expect(issuesOf(() => parseConfig({ aproval: { channel: 'chat' } })).join()).toMatch(/aproval/);
    expect(issuesOf(() => parseConfig({ approval: { autoApprove: true } })).join()).toMatch(
      /autoApprove/,
    );
  });

  it.each([
    [{ approval: { channel: 'auto' } }, 'approval.channel'],
    [{ approval: { expiryMinutes: 0 } }, 'approval.expiryMinutes'],
    [{ approval: { expiryMinutes: 1.5 } }, 'approval.expiryMinutes'],
    [{ execution: { timeoutMinutes: 10_000 } }, 'execution.timeoutMinutes'],
    [{ execution: { maxOutputBytes: 10 } }, 'execution.maxOutputBytes'],
    [{ mcp: { maxResponseBytes: '64k' } }, 'mcp.maxResponseBytes'],
    [{ logLevel: 'verbose' }, 'logLevel'],
  ])('rejects out-of-range or wrong-type values: %j', (raw, field) => {
    expect(issuesOf(() => parseConfig(raw)).join()).toContain(field);
  });

  it.each([[[]], ['text'], [42], [null]])('rejects a non-object root (%j)', (raw) => {
    expect(() => parseConfig(raw)).toThrow(UabError);
  });

  it('applies UAB_LOG_LEVEL over the file value, and validates it', () => {
    expect(parseConfig({ logLevel: 'info' }, { UAB_LOG_LEVEL: 'warn' }).logLevel).toBe('warn');
    expect(parseConfig({}, { UAB_LOG_LEVEL: '' }).logLevel).toBe('info');
    expect(() => parseConfig({}, { UAB_LOG_LEVEL: 'loud' })).toThrow(UabError);
  });

  it('exposes the schema for documentation generation', () => {
    expect(configSchema.safeParse({}).success).toBe(true);
  });
});

describe('loadConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'uab-config-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses defaults when the config file does not exist', async () => {
    const loaded = await loadConfig({ env: { UAB_HOME: dir } });
    expect(loaded.dataDir).toBe(path.normalize(dir));
    expect(loaded.configPath).toBe(path.join(dir, 'config.json'));
    expect(loaded.fromFile).toBe(false);
    expect(loaded.config.approval.channel).toBe('local');
  });

  it('reads and validates an existing config file', async () => {
    writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ execution: { timeoutMinutes: 5 } }),
    );
    const loaded = await loadConfig({ env: { UAB_HOME: dir } });
    expect(loaded.fromFile).toBe(true);
    expect(loaded.config.execution.timeoutMinutes).toBe(5);
  });

  it('honours UAB_CONFIG', async () => {
    const custom = path.join(dir, 'custom.json');
    writeFileSync(custom, JSON.stringify({ logLevel: 'error' }));
    const loaded = await loadConfig({ env: { UAB_HOME: dir, UAB_CONFIG: custom } });
    expect(loaded.configPath).toBe(custom);
    expect(loaded.config.logLevel).toBe('error');
  });

  it('fails with CONFIG_INVALID on malformed JSON', async () => {
    writeFileSync(path.join(dir, 'config.json'), '{ not json');
    await expect(loadConfig({ env: { UAB_HOME: dir } })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it('fails with CONFIG_NOT_READABLE on read errors other than "not found"', async () => {
    const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    await expect(
      loadConfig({
        env: { UAB_HOME: dir },
        readTextFile: () => Promise.reject(denied),
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_NOT_READABLE' });
  });

  it('fails with CONFIG_INVALID for a relative UAB_HOME', async () => {
    await expect(loadConfig({ env: { UAB_HOME: 'relative' } })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });
});
