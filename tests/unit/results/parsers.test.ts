import { describe, expect, it } from 'vitest';
import { mcpConfigToml, codexConfigPath } from '../../../src/mcp/config.js';
import { parsePorcelain } from '../../../src/results/git.js';
import { parseTestSummary } from '../../../src/results/tests.js';

describe('parseTestSummary', () => {
  it.each([
    [
      ' Test Files  5 passed (5)\n      Tests  59 passed (59)',
      { passed: 59, failed: 0, format: 'vitest' },
    ],
    [
      ' Test Files  1 failed | 4 passed (5)\n      Tests  2 failed | 57 passed | 1 skipped (60)',
      { passed: 57, failed: 2, skipped: 1, format: 'vitest' },
    ],
    [
      'Tests:       1 failed, 2 skipped, 10 passed, 13 total',
      { passed: 10, failed: 1, skipped: 2, format: 'jest' },
    ],
    [
      '============ 3 failed, 12 passed in 1.23s ============',
      { passed: 12, failed: 3, format: 'pytest' },
    ],
    [
      'test result: FAILED. 8 passed; 1 failed; 0 ignored; 0 measured',
      { passed: 8, failed: 1, format: 'cargo' },
    ],
    [
      'ok  \tgithub.com/x/y\t0.01s\nFAIL\tgithub.com/x/z\t0.02s',
      { passed: 1, failed: 1, format: 'go' },
    ],
  ])('parses %j', (output, expected) => {
    expect(parseTestSummary(output)).toMatchObject(expected);
  });

  it('returns nulls for unknown output', () => {
    expect(parseTestSummary('all good')).toEqual({
      passed: null,
      failed: null,
      skipped: null,
      format: null,
    });
  });
});

describe('parsePorcelain', () => {
  it('classifies entries and handles renames and spaces', () => {
    expect(
      parsePorcelain(' M src/a.ts\0?? new file.txt\0D  old.ts\0R  b.ts\0a.ts\0A  added.ts\0'),
    ).toEqual([
      { path: 'src/a.ts', code: ' M', change: 'modified' },
      { path: 'new file.txt', code: '??', change: 'created' },
      { path: 'old.ts', code: 'D ', change: 'deleted' },
      { path: 'b.ts', code: 'R ', change: 'renamed' },
      { path: 'added.ts', code: 'A ', change: 'created' },
    ]);
  });
});

describe('mcpConfigToml', () => {
  it('produces the shared Codex/ChatGPT desktop config with escaped Windows paths', () => {
    const toml = mcpConfigToml({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      cliPath: 'C:\\tools\\uab\\dist\\cli.js',
    });
    expect(toml).toContain('[mcp_servers.uab]');
    expect(toml).toContain('command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"');
    expect(toml).toContain('args = ["C:\\\\tools\\\\uab\\\\dist\\\\cli.js", "mcp"]');
    expect(toml).toContain('default_tools_approval_mode = "writes"');
    expect(toml).toContain('[mcp_servers.uab.tools.dispatch_task]\napproval_mode = "prompt"');
    expect(toml).not.toContain('[mcp_servers.uab.env]');
  });

  it('pins UAB_HOME when given', () => {
    expect(mcpConfigToml({ nodePath: '/n', cliPath: '/c', uabHome: '/data/uab' })).toContain(
      '[mcp_servers.uab.env]\nUAB_HOME = "/data/uab"',
    );
  });

  it('honours an absolute CODEX_HOME', () => {
    expect(codexConfigPath('/home/u', {})).toMatch(/[\\/]home[\\/]u[\\/]\.codex[\\/]config\.toml$/);
    expect(codexConfigPath('/home/u', { CODEX_HOME: '/x/codex' })).toMatch(
      /[\\/]x[\\/]codex[\\/]config\.toml$/,
    );
    expect(codexConfigPath('/home/u', { CODEX_HOME: 'relative' })).toMatch(/\.codex/);
  });
});
