import path from 'node:path';
import { ErrorCode, UabError } from './errors.js';

/** The `node:path` API shape shared by `path.win32` and `path.posix`. */
type PathApi = typeof path.win32;

export interface PathEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
}

const APP_DIR_NAME = 'uab';

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function pathApi(platform: NodeJS.Platform): PathApi {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * Returns the absolute UAB data directory (database, logs, default config file).
 * `UAB_HOME` overrides the platform default and must be absolute, so a relative value can
 * never resolve against whatever working directory the MCP host happens to use.
 */
export function resolveDataDir({ env, platform, homedir }: PathEnvironment): string {
  const p = pathApi(platform);
  const override = nonEmpty(env.UAB_HOME);
  if (override !== undefined) {
    if (!p.isAbsolute(override)) {
      throw new UabError(ErrorCode.CONFIG_INVALID, 'UAB_HOME must be an absolute path.', {
        details: { variable: 'UAB_HOME' },
      });
    }
    return p.normalize(override);
  }

  switch (platform) {
    case 'win32': {
      const localAppData = nonEmpty(env.LOCALAPPDATA);
      const base =
        localAppData !== undefined && p.isAbsolute(localAppData)
          ? localAppData
          : p.join(homedir, 'AppData', 'Local');
      return p.join(base, APP_DIR_NAME);
    }
    case 'darwin':
      return p.join(homedir, 'Library', 'Application Support', APP_DIR_NAME);
    default: {
      const xdg = nonEmpty(env.XDG_DATA_HOME);
      const base =
        xdg !== undefined && p.isAbsolute(xdg) ? xdg : p.join(homedir, '.local', 'share');
      return p.join(base, APP_DIR_NAME);
    }
  }
}

/** Returns the absolute config file path: `UAB_CONFIG` if set, else `<dataDir>/config.json`. */
export function resolveConfigPath(dataDir: string, pathEnv: PathEnvironment): string {
  const p = pathApi(pathEnv.platform);
  const override = nonEmpty(pathEnv.env.UAB_CONFIG);
  if (override !== undefined) {
    if (!p.isAbsolute(override)) {
      throw new UabError(ErrorCode.CONFIG_INVALID, 'UAB_CONFIG must be an absolute path.', {
        details: { variable: 'UAB_CONFIG' },
      });
    }
    return p.normalize(override);
  }
  return p.join(dataDir, 'config.json');
}
