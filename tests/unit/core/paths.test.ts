import { describe, expect, it } from 'vitest';
import { isUabError } from '../../../src/core/errors.js';
import { resolveConfigPath, resolveDataDir } from '../../../src/core/paths.js';

describe('resolveDataDir', () => {
  it('uses LOCALAPPDATA on Windows', () => {
    expect(
      resolveDataDir({
        env: { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
        platform: 'win32',
        homedir: 'C:\\Users\\dev',
      }),
    ).toBe('C:\\Users\\dev\\AppData\\Local\\uab');
  });

  it('falls back to <home>\\AppData\\Local on Windows when LOCALAPPDATA is missing or relative', () => {
    for (const LOCALAPPDATA of [undefined, '', 'relative\\dir']) {
      expect(
        resolveDataDir({ env: { LOCALAPPDATA }, platform: 'win32', homedir: 'C:\\Users\\dev' }),
      ).toBe('C:\\Users\\dev\\AppData\\Local\\uab');
    }
  });

  it('uses Application Support on macOS', () => {
    expect(resolveDataDir({ env: {}, platform: 'darwin', homedir: '/Users/dev' })).toBe(
      '/Users/dev/Library/Application Support/uab',
    );
  });

  it('uses XDG_DATA_HOME on Linux, else ~/.local/share', () => {
    expect(
      resolveDataDir({ env: { XDG_DATA_HOME: '/data' }, platform: 'linux', homedir: '/home/dev' }),
    ).toBe('/data/uab');
    expect(resolveDataDir({ env: {}, platform: 'linux', homedir: '/home/dev' })).toBe(
      '/home/dev/.local/share/uab',
    );
    expect(
      resolveDataDir({ env: { XDG_DATA_HOME: 'rel' }, platform: 'linux', homedir: '/home/dev' }),
    ).toBe('/home/dev/.local/share/uab');
  });

  it('honours an absolute UAB_HOME and normalises it', () => {
    expect(
      resolveDataDir({
        env: { UAB_HOME: '/srv/uab/../uab-data' },
        platform: 'linux',
        homedir: '/h',
      }),
    ).toBe('/srv/uab-data');
  });

  it('treats an empty UAB_HOME as unset', () => {
    expect(resolveDataDir({ env: { UAB_HOME: '  ' }, platform: 'linux', homedir: '/h' })).toBe(
      '/h/.local/share/uab',
    );
  });

  it.each(['relative/dir', './uab', '..\\up'])('rejects a relative UAB_HOME (%s)', (value) => {
    try {
      resolveDataDir({ env: { UAB_HOME: value }, platform: 'linux', homedir: '/h' });
      expect.unreachable();
    } catch (error) {
      expect(isUabError(error, 'CONFIG_INVALID')).toBe(true);
    }
  });
});

describe('resolveConfigPath', () => {
  const pathEnv = { platform: 'linux' as const, homedir: '/h' };

  it('defaults to <dataDir>/config.json', () => {
    expect(resolveConfigPath('/d/uab', { ...pathEnv, env: {} })).toBe('/d/uab/config.json');
  });

  it('honours an absolute UAB_CONFIG', () => {
    expect(resolveConfigPath('/d/uab', { ...pathEnv, env: { UAB_CONFIG: '/etc/uab.json' } })).toBe(
      '/etc/uab.json',
    );
  });

  it('rejects a relative UAB_CONFIG', () => {
    expect(() =>
      resolveConfigPath('/d/uab', { ...pathEnv, env: { UAB_CONFIG: 'uab.json' } }),
    ).toThrow(/absolute/);
  });
});
