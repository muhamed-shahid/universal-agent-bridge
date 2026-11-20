import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Finds the real program behind a CLI name without using a shell.
 *
 * On Windows, npm installs CLIs as `.cmd` wrappers. Node cannot start a `.cmd` file without a
 * shell, and running prompts through cmd.exe would allow argument injection. UAB therefore reads
 * the wrapper, extracts the target it launches (a native `.exe`, or `node <script>`), checks the
 * target exists inside the wrapper's directory tree, and runs that target directly.
 */

export interface ResolvedExecutable {
  /** Absolute path of the program to spawn. */
  readonly command: string;
  /** Arguments that must precede the CLI's own arguments (for example a script path). */
  readonly prefixArgs: readonly string[];
  /** Where the program was found. */
  readonly source: 'path' | 'config';
  /** The file found on PATH or configured, before unwrapping (for display). */
  readonly foundAt: string;
}

export type ResolveFailure =
  | { readonly reason: 'not_found' }
  | { readonly reason: 'not_executable'; readonly foundAt: string }
  | { readonly reason: 'unsupported_wrapper'; readonly foundAt: string }
  | { readonly reason: 'invalid_override'; readonly foundAt: string };

export type ResolveResult =
  | { readonly ok: true; readonly executable: ResolvedExecutable }
  | ({ readonly ok: false } & ResolveFailure);

export interface ResolveOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  /** Absolute path from configuration; skips the PATH search. */
  readonly override?: string;
}

function envValue(env: Readonly<Record<string, string | undefined>>, name: string, win: boolean) {
  if (!win) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isExecutable(file: string, win: boolean): boolean {
  if (!isFile(file)) return false;
  if (win) return true;
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// npm / cmd-shim wrappers, both styles:
//   "%dp0%\node_modules\pkg\bin\tool.exe"   %*
//   endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\pkg\bin\tool.js" %*
const NATIVE_SHIM = /^\s*"%dp0%\\([^"%]+\.(?:exe|com))"\s+%\*\s*$/im;
const NODE_SHIM = /&\s*"%_prog%"\s+"%dp0%\\([^"%]+\.(?:js|cjs|mjs))"\s+%\*\s*$/im;

function insideDir(dir: string, candidate: string): boolean {
  const rel = path.win32.relative(dir.toLowerCase(), candidate.toLowerCase());
  return rel !== '' && !rel.startsWith('..') && !path.win32.isAbsolute(rel);
}

function resolveNode(
  shimDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const local = path.win32.join(shimDir, 'node.exe');
  if (isFile(local)) return realpathSync.native(local);
  const found = searchPath(['node'], env, true);
  return found !== undefined && /\.(exe|com)$/i.test(found)
    ? realpathSync.native(found)
    : undefined;
}

/** Reads a Windows wrapper script and returns the program it really runs. */
export function unwrapWindowsShim(
  shim: string,
  env: Readonly<Record<string, string | undefined>>,
): Pick<ResolvedExecutable, 'command' | 'prefixArgs'> | undefined {
  let text: string;
  try {
    const stat = statSync(shim);
    if (stat.size > 64 * 1024) return undefined;
    text = readFileSync(shim, 'utf8');
  } catch {
    return undefined;
  }
  const dir = path.win32.dirname(shim);

  const target = (relative: string): string | undefined => {
    const candidate = path.win32.join(dir, relative);
    if (!isFile(candidate)) return undefined;
    const real = realpathSync.native(candidate);
    // The wrapper may only point at files inside its own directory tree.
    return insideDir(realpathSync.native(dir), real) ? real : undefined;
  };

  const native = NATIVE_SHIM.exec(text);
  if (native?.[1] !== undefined) {
    const exe = target(native[1]);
    return exe === undefined ? undefined : { command: exe, prefixArgs: [] };
  }
  const node = NODE_SHIM.exec(text);
  if (node?.[1] !== undefined) {
    const script = target(node[1]);
    const nodeExe = script === undefined ? undefined : resolveNode(dir, env);
    return script === undefined || nodeExe === undefined
      ? undefined
      : { command: nodeExe, prefixArgs: [script] };
  }
  return undefined;
}

function windowsExtensions(env: Readonly<Record<string, string | undefined>>): string[] {
  const configured = (envValue(env, 'PATHEXT', true) ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^\.[a-z0-9]{1,8}$/.test(e));
  // Only these can be run (directly or by unwrapping). Native programs win over wrappers.
  const supported = ['.exe', '.com', '.cmd', '.bat'];
  return supported.filter((e) => configured.includes(e));
}

/** Returns the first matching file on PATH (not yet unwrapped). */
export function searchPath(
  names: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  win: boolean,
): string | undefined {
  const p = win ? path.win32 : path.posix;
  const dirs = (envValue(env, 'PATH', win) ?? '')
    .split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d !== '' && p.isAbsolute(d)); // relative PATH entries are ignored (hijack risk)
  const exts = win ? windowsExtensions(env) : [''];
  for (const dir of dirs) {
    for (const name of names) {
      for (const ext of exts) {
        const file = p.join(dir, name + ext);
        if (isExecutable(file, win)) return file;
      }
    }
  }
  return undefined;
}

function finish(
  found: string,
  source: 'path' | 'config',
  env: Readonly<Record<string, string | undefined>>,
  win: boolean,
): ResolveResult {
  if (win && /\.(cmd|bat)$/i.test(found)) {
    const unwrapped = unwrapWindowsShim(found, env);
    if (unwrapped === undefined)
      return { ok: false, reason: 'unsupported_wrapper', foundAt: found };
    return { ok: true, executable: { ...unwrapped, source, foundAt: found } };
  }
  if (win && !/\.(exe|com)$/i.test(found)) {
    return { ok: false, reason: 'not_executable', foundAt: found };
  }
  return {
    ok: true,
    executable: { command: realpathSync.native(found), prefixArgs: [], source, foundAt: found },
  };
}

export function resolveExecutable(
  names: readonly string[],
  options: ResolveOptions,
): ResolveResult {
  const win = (options.platform ?? process.platform) === 'win32';
  const p = win ? path.win32 : path.posix;

  if (options.override !== undefined) {
    const file = options.override;
    if (!p.isAbsolute(file)) return { ok: false, reason: 'invalid_override', foundAt: file };
    if (!isExecutable(file, win)) return { ok: false, reason: 'not_executable', foundAt: file };
    return finish(file, 'config', options.env, win);
  }

  const found = searchPath(names, options.env, win);
  return found === undefined
    ? { ok: false, reason: 'not_found' }
    : finish(found, 'path', options.env, win);
}
