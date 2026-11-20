import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createSandbox, type Sandbox } from '../helpers/fs.js';

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

/** Runs the built `uab mcp` exactly as the ChatGPT desktop app does: a child process on stdio. */
describe.runIf(existsSync(CLI))('uab mcp over stdio (built CLI)', () => {
  let sb: Sandbox | undefined;
  afterEach(() => {
    sb?.cleanup();
    sb = undefined;
  });

  it('initialises, lists tools and answers calls with clean JSON-RPC on stdout', async () => {
    sb = createSandbox();
    const env: Record<string, string> = { UAB_HOME: sb.dataDir, PATH: process.env.PATH ?? '' };
    for (const k of [
      'SystemRoot',
      'TEMP',
      'TMP',
      'USERPROFILE',
      'HOME',
      'LOCALAPPDATA',
      'APPDATA',
    ]) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'mcp'],
      env,
      cwd: sb.root,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe('universal-agent-bridge');
      const { tools } = await client.listTools();
      expect(tools.length).toBe(31);
      const r = await client.callTool({ name: 'list_agents', arguments: {} });
      const text = (r.content as { text: string }[])[0]?.text ?? '';
      expect(
        (JSON.parse(text) as { agents: { agentId: string }[] }).agents.map((a) => a.agentId),
      ).toEqual(['kiro', 'claude', 'opencode', 'codex']);
      const bad = await client.callTool({
        name: 'get_session',
        arguments: { sessionId: 'UAB-000000000000', sessionToken: 'x' },
      });
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 30_000);
});
