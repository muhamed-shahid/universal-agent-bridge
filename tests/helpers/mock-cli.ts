import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveExecutable } from '../../src/agents/resolve.js';
import {
  parseJsonLine,
  parseJsonObject,
  parseSemver,
  safeLabel,
  type AgentDefinition,
  type AgentEvent,
  type AgentExecution,
  type AuthResult,
  type ProbeOutput,
} from '../../src/agents/types.js';

export const MOCK_CLI_SCRIPT = fileURLToPath(new URL('../fixtures/mock-cli.mjs', import.meta.url));

/**
 * Installs the mock CLI under `binDir` as `name`, the way a package manager would:
 * - Windows: an npm-style `.cmd` wrapper (node-script form) pointing into `node_modules`,
 *   which UAB must unwrap because it never runs `.cmd` files.
 * - POSIX: an executable script with a shebang for the current Node binary.
 * Returns the directory to put on PATH.
 */
export function installMockCli(binDir: string, name = 'mockagent', fixedScenario?: string): string {
  mkdirSync(binDir, { recursive: true });
  // A fixed scenario is baked into the launcher, for agents whose environment allowlist
  // (correctly) does not pass MOCK_CLI_SCENARIO through.
  const preset =
    fixedScenario === undefined
      ? ''
      : `process.env.MOCK_CLI_SCENARIO = ${JSON.stringify(fixedScenario)};\n`;
  const launcher = `${preset}import(${JSON.stringify(pathToFileURL(MOCK_CLI_SCRIPT).href)});\n`;
  if (process.platform === 'win32') {
    const pkgBin = path.join(binDir, 'node_modules', 'mock-agent', 'bin');
    mkdirSync(pkgBin, { recursive: true });
    writeFileSync(path.join(pkgBin, 'mock.js'), launcher);
    writeFileSync(
      path.join(binDir, `${name}.cmd`),
      [
        '@ECHO off',
        'GOTO start',
        ':find_dp0',
        'SET dp0=%~dp0',
        'EXIT /b',
        ':start',
        'SETLOCAL',
        'CALL :find_dp0',
        '',
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ') ELSE (',
        '  SET "_prog=node"',
        '  SET PATHEXT=%PATHEXT:;.JS;=;%',
        ')',
        '',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\mock-agent\\bin\\mock.js" %*',
        '',
      ].join('\r\n'),
    );
  } else {
    const file = path.join(binDir, name);
    writeFileSync(file, `#!${process.execPath}\n${launcher}`);
    chmodSync(file, 0o755);
  }
  return binDir;
}

/** Environment for detection tests: PATH has the mock bin dir and Node, nothing else. */
export function mockEnv(binDir: string, scenario: string, extra: Record<string, string> = {}) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const env: Record<string, string> = {
    PATH: [binDir, path.dirname(process.execPath)].join(sep),
    MOCK_CLI_SCENARIO: scenario,
    ...extra,
  };
  if (process.platform === 'win32') {
    env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
    env.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  }
  return env;
}

export function parseMockAuth(output: ProbeOutput): AuthResult {
  const json = parseJsonObject(output.stdout);
  if (json === undefined || typeof json.loggedIn !== 'boolean') return { state: 'unknown' };
  if (!json.loggedIn) return { state: 'not_authenticated' };
  const method = safeLabel(json.authMethod);
  return { state: 'authenticated', ...(method === undefined ? {} : { method }) };
}

export function mockDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'mockagent',
    displayName: 'Mock Agent',
    executableNames: ['mockagent'],
    versionProbe: { args: ['--version'], parse: parseSemver },
    authProbe: { args: ['auth', 'status', '--json'], parse: parseMockAuth },
    envPassthrough: ['MOCK_CLI_SCENARIO', 'MOCK_API_KEY'],
    forbiddenArgs: [{ flag: '--yolo', reason: 'test' }],
    capabilities: { resume: false, callerChosenSessionId: false, structuredEvents: false },
    instructions: {
      install: ['npm install -g mock-agent'],
      authenticate: ['mockagent login'],
      docsUrl: 'https://example.com/mock-agent',
    },
    ...overrides,
  };
}

/** Execution adapter for the mock CLI's `run` command (JSON lines on stdout). */
export const mockExecution: AgentExecution = {
  supported: true,
  verified: true,
  setupHint: 'mock setup hint',
  buildInvocation(req) {
    const args = ['run', '--mode', req.mode];
    if (req.nativeSessionId !== null) args.push('--resume', req.nativeSessionId);
    return { args, stdin: req.prompt };
  },
  parseStdoutLine(line): AgentEvent[] {
    const j = parseJsonLine(line);
    if (j === undefined) return [];
    switch (j.type) {
      case 'session':
        return [{ type: 'session', nativeSessionId: String(j.id) }];
      case 'text':
        return [{ type: 'text', text: String(j.text) }];
      case 'tool':
        return [{ type: 'tool', name: String(j.name), status: 'started', path: String(j.path) }];
      case 'denied':
        return [{ type: 'permission_denied', tool: String(j.tool) }];
      case 'final':
        return [{ type: 'final', text: String(j.text), success: j.success === true }];
      default:
        return [];
    }
  },
};

export function mockAgentDefinition(): AgentDefinition {
  return mockDefinition({ execution: mockExecution });
}

/** Directory containing git, so tests can use a real repository. */
export function gitDir(): string | undefined {
  const r = resolveExecutable(['git'], { env: process.env });
  return r.ok ? path.dirname(r.executable.foundAt) : undefined;
}
