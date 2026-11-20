import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../../src/core/logger.js';
import { VERSION } from '../../../src/core/version.js';

describe('createLogger', () => {
  const fixed = () => new Date('2026-01-01T00:00:00.000Z');

  it('writes JSON lines at or above the configured level', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', write: (l) => lines.push(l), now: fixed });
    logger.debug('d');
    logger.info('i');
    logger.warn('w', { taskId: 'T1' });
    logger.error('e');
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      { ts: '2026-01-01T00:00:00.000Z', level: 'warn', msg: 'w', taskId: 'T1' },
      { ts: '2026-01-01T00:00:00.000Z', level: 'error', msg: 'e' },
    ]);
  });

  it('writes to stderr by default, never stdout (stdout carries MCP JSON-RPC)', () => {
    const errWrites: unknown[] = [];
    const outWrites: unknown[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    const origOut = process.stdout.write.bind(process.stdout);
    process.stderr.write = (chunk: unknown) => errWrites.push(chunk) > 0;
    process.stdout.write = (chunk: unknown) => outWrites.push(chunk) > 0;
    try {
      createLogger({ level: 'debug' }).info('hello');
    } finally {
      process.stderr.write = origErr;
      process.stdout.write = origOut;
    }
    expect(errWrites).toHaveLength(1);
    expect(outWrites).toHaveLength(0);
  });
});

describe('VERSION', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });
});
