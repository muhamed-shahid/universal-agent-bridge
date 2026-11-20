import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openApp, type AppOptions } from '../app.js';
import { createMcpServer } from './server.js';

/**
 * Runs the MCP server on stdin/stdout until the host closes the connection. stdout carries
 * JSON-RPC only; all logging goes to stderr.
 */
export async function runMcpStdio(options: AppOptions = {}): Promise<void> {
  const app = await openApp(options);
  const recovered = app.executions.recover();
  app.logger.info('UAB MCP server starting', {
    version: process.env.npm_package_version,
    recovered,
  });
  const server = createMcpServer({ app, maxResponseBytes: app.loaded.config.mcp.maxResponseBytes });
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = async (reason: string) => {
    if (closing) return;
    closing = true;
    app.logger.info('UAB MCP server stopping', { reason, running: app.executions.activeCount });
    try {
      await app.executions.shutdown();
      await server.close();
    } finally {
      app.close();
    }
  };

  await new Promise<void>((resolve) => {
    transport.onclose = () => {
      void shutdown('transport closed').finally(resolve);
    };
    process.stdin.on('end', () => {
      void shutdown('stdin closed').finally(resolve);
    });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void shutdown(signal).finally(resolve);
      });
    }
    server.connect(transport).catch((error: unknown) => {
      app.logger.error('MCP transport failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      void shutdown('transport error').finally(resolve);
    });
  });
}
