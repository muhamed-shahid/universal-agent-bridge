/**
 * Environment passed to child processes. UAB never forwards its whole environment: only the
 * variables a CLI needs to find its own configuration and login (home, app-data and temp
 * directories, PATH, locale), plus names an adapter explicitly declares.
 */
const BASE_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  // Network proxies (the CLIs need them to reach their providers)
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  // Windows
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'USERPROFILE',
  'USERNAME',
  'USERDOMAIN',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES',
  'TEMP',
  'TMP',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
] as const;

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_()]{0,63}$/;

export function isValidEnvName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/**
 * Builds a child environment from `source`, keeping only allowlisted names. Matching is
 * case-insensitive on Windows (where `Path` and `PATH` are the same variable).
 */
export function buildChildEnv(
  source: Readonly<Record<string, string | undefined>>,
  extraNames: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const wanted = new Set<string>();
  for (const name of [...BASE_ALLOWLIST, ...extraNames]) {
    if (!isValidEnvName(name)) continue;
    wanted.add(platform === 'win32' ? name.toUpperCase() : name);
  }
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const key = platform === 'win32' ? name.toUpperCase() : name;
    if (wanted.has(key)) env[name] = value;
  }
  // Make CLIs behave as non-interactive tools: no colours, no prompts, no pagers.
  env.NO_COLOR = '1';
  env.CI = env.CI ?? '1';
  env.TERM = 'dumb';
  return env;
}
