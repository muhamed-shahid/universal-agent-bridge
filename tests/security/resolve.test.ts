import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveExecutable, unwrapWindowsShim } from '../../src/agents/resolve.js';
import { makeDir, makeFile, makeTempDir, removeDir } from '../helpers/fs.js';

const win = process.platform === 'win32';
const sep = win ? ';' : ':';

function cmdShim(file: string, target: string): void {
  writeFileSync(
    file,
    [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      `"%dp0%\\${target}"   %*`,
      '',
    ].join('\r\n'),
  );
}

function nodeShim(file: string, script: string): void {
  writeFileSync(
    file,
    [
      '@ECHO off',
      'SETLOCAL',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      ')',
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`,
      '',
    ].join('\r\n'),
  );
}

describe('resolveExecutable', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir('uab-resolve-');
  });
  afterEach(() => {
    removeDir(dir);
  });

  it('reports not_found when nothing matches', () => {
    expect(resolveExecutable(['nothing-here'], { env: { PATH: dir } })).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('ignores relative PATH entries (a project folder cannot hijack the CLI)', () => {
    const bin = makeDir(dir, 'rel');
    makeFile(path.join(bin, win ? 'tool.exe' : 'tool'));
    if (!win) chmodSync(path.join(bin, 'tool'), 0o755);
    const original = process.cwd();
    process.chdir(dir);
    try {
      expect(resolveExecutable(['tool'], { env: { PATH: `rel${sep}.`, PATHEXT: '.EXE' } }).ok).toBe(
        false,
      );
    } finally {
      process.chdir(original);
    }
  });

  it('uses the first PATH directory that has the program', () => {
    const a = makeDir(dir, 'a');
    const b = makeDir(dir, 'b');
    for (const d of [a, b]) {
      makeFile(path.join(d, win ? 'tool.exe' : 'tool'));
      if (!win) chmodSync(path.join(d, 'tool'), 0o755);
    }
    const r = resolveExecutable(['tool'], { env: { PATH: `${b}${sep}${a}`, PATHEXT: '.EXE' } });
    expect(r.ok && r.executable.command).toBe(path.join(b, win ? 'tool.exe' : 'tool'));
  });

  it('rejects a relative override and a missing override', () => {
    expect(resolveExecutable(['x'], { env: {}, override: 'bin/tool' })).toMatchObject({
      ok: false,
      reason: 'invalid_override',
    });
    expect(
      resolveExecutable(['x'], { env: {}, override: path.join(dir, 'missing') }),
    ).toMatchObject({
      ok: false,
      reason: 'not_executable',
    });
  });

  it.runIf(!win)('skips files without the execute bit on POSIX', () => {
    makeFile(path.join(dir, 'tool'));
    expect(resolveExecutable(['tool'], { env: { PATH: dir } }).ok).toBe(false);
  });

  describe.runIf(win)('Windows wrappers', () => {
    it('prefers a native .exe over a .cmd wrapper in the same directory', () => {
      makeFile(path.join(dir, 'tool.exe'));
      cmdShim(path.join(dir, 'tool.cmd'), 'other.exe');
      const r = resolveExecutable(['tool'], { env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' } });
      expect(r.ok && r.executable.command).toBe(path.join(dir, 'tool.exe'));
    });

    it('unwraps an npm wrapper that launches a native program', () => {
      const exe = makeFile(path.join(dir, 'node_modules', 'pkg', 'bin', 'tool.exe'));
      cmdShim(path.join(dir, 'tool.cmd'), 'node_modules\\pkg\\bin\\tool.exe');
      const r = resolveExecutable(['tool'], { env: { PATH: dir, PATHEXT: '.CMD' } });
      expect(r).toEqual({
        ok: true,
        executable: {
          command: exe,
          prefixArgs: [],
          source: 'path',
          foundAt: path.join(dir, 'tool.cmd'),
        },
      });
    });

    it('unwraps an npm wrapper that launches a Node script, using node from PATH', () => {
      const script = makeFile(path.join(dir, 'node_modules', 'pkg', 'bin', 'tool.js'));
      nodeShim(path.join(dir, 'tool.cmd'), 'node_modules\\pkg\\bin\\tool.js');
      const r = resolveExecutable(['tool'], {
        env: { PATH: `${dir};${path.dirname(process.execPath)}`, PATHEXT: '.EXE;.CMD' },
      });
      expect(r.ok && r.executable.prefixArgs).toEqual([script]);
      expect(r.ok && r.executable.command.toLowerCase()).toBe(process.execPath.toLowerCase());
    });

    it('refuses a wrapper that points outside its own directory', () => {
      const outside = makeDir(dir, 'outside');
      makeFile(path.join(outside, 'evil.exe'));
      const bin = makeDir(dir, 'bin');
      cmdShim(path.join(bin, 'tool.cmd'), '..\\outside\\evil.exe');
      expect(resolveExecutable(['tool'], { env: { PATH: bin, PATHEXT: '.CMD' } })).toMatchObject({
        ok: false,
        reason: 'unsupported_wrapper',
      });
    });

    it('refuses wrappers it does not recognise instead of running them through cmd.exe', () => {
      writeFileSync(path.join(dir, 'tool.cmd'), '@echo off\r\npowershell -c "do-things %*"\r\n');
      writeFileSync(path.join(dir, 'other.bat'), 'start calc.exe\r\n');
      for (const name of ['tool', 'other']) {
        expect(
          resolveExecutable([name], { env: { PATH: dir, PATHEXT: '.BAT;.CMD' } }),
        ).toMatchObject({
          ok: false,
          reason: 'unsupported_wrapper',
        });
      }
    });

    it('refuses a wrapper whose target does not exist', () => {
      cmdShim(path.join(dir, 'tool.cmd'), 'node_modules\\gone\\tool.exe');
      expect(resolveExecutable(['tool'], { env: { PATH: dir, PATHEXT: '.CMD' } })).toMatchObject({
        reason: 'unsupported_wrapper',
      });
    });

    it('never picks .ps1, .js or .vbs files even if PATHEXT lists them', () => {
      for (const ext of ['.ps1', '.js', '.vbs']) makeFile(path.join(dir, `tool${ext}`));
      expect(resolveExecutable(['tool'], { env: { PATH: dir, PATHEXT: '.PS1;.JS;.VBS' } }).ok).toBe(
        false,
      );
    });

    it('honours an override that is a wrapper by unwrapping it', () => {
      const exe = makeFile(path.join(dir, 'node_modules', 'p', 'tool.exe'));
      cmdShim(path.join(dir, 'tool.cmd'), 'node_modules\\p\\tool.exe');
      const r = resolveExecutable(['x'], { env: {}, override: path.join(dir, 'tool.cmd') });
      expect(r.ok && r.executable).toMatchObject({ command: exe, source: 'config' });
    });

    it('does not read oversized wrapper files', () => {
      writeFileSync(path.join(dir, 'big.cmd'), 'x'.repeat(100 * 1024));
      expect(unwrapWindowsShim(path.join(dir, 'big.cmd'), {})).toBeUndefined();
    });
  });
});
