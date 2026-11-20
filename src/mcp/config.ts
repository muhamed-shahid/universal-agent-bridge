import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Generates the `[mcp_servers.uab]` entry for the shared Codex/ChatGPT desktop configuration
 * file (`~/.codex/config.toml`). Only documented keys are used: command, args, env,
 * startup_timeout_sec, tool_timeout_sec, default_tools_approval_mode, tools.<name>.approval_mode.
 */

export function codexConfigPath(
  homedir = os.homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const codexHome = env.CODEX_HOME?.trim();
  return codexHome !== undefined && codexHome !== '' && path.isAbsolute(codexHome)
    ? path.join(codexHome, 'config.toml')
    : path.join(homedir, '.codex', 'config.toml');
}

/** TOML basic string. JSON string escaping is valid TOML for these characters. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

export interface McpConfigOptions {
  readonly nodePath?: string;
  readonly cliPath?: string;
  /** Absolute UAB_HOME to pin, if the user uses a non-default data directory. */
  readonly uabHome?: string | undefined;
  readonly serverName?: string;
}

export function defaultCliPath(): string {
  // dist/mcp/config.js -> dist/cli.js
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
}

export function mcpConfigToml(options: McpConfigOptions = {}): string {
  const name = options.serverName ?? 'uab';
  const node = options.nodePath ?? process.execPath;
  const cli = options.cliPath ?? defaultCliPath();
  const lines = [
    `# Universal Agent Bridge. Paste into ~/.codex/config.toml (shared by the ChatGPT desktop app and Codex).`,
    `[mcp_servers.${name}]`,
    `command = ${tomlString(node)}`,
    `args = [${tomlString(cli)}, "mcp"]`,
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 120',
    '# Ask before every tool that is not read-only.',
    'default_tools_approval_mode = "writes"',
  ];
  if (options.uabHome !== undefined) {
    lines.push('', `[mcp_servers.${name}.env]`, `UAB_HOME = ${tomlString(options.uabHome)}`);
  }
  for (const tool of ['dispatch_task', 'approve_task', 'cancel_task']) {
    lines.push('', `[mcp_servers.${name}.tools.${tool}]`, 'approval_mode = "prompt"');
  }
  return lines.join('\n') + '\n';
}
