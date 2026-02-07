#!/usr/bin/env node

import { McpBundler } from '@kunobi/mcp-bundler';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getMcpUrl } from './discovery.js';
import { registerStatusTool } from './tools/status.js';

const server = new McpServer(
  { name: 'kunobi', version: '0.0.1' },
  { capabilities: { tools: { listChanged: true } } },
);

registerStatusTool(server);

const bundler = new McpBundler({
  name: 'kunobi',
  url: getMcpUrl(),
  reconnect: {
    enabled: true,
    intervalMs: 5_000,
    maxRetries: Number.POSITIVE_INFINITY,
  },
  logger: (level: string, msg: string, data?: unknown) => {
    if (level === 'error') {
      console.error(`[kunobi-mcp] ${msg}`, data ?? '');
    }
  },
});

async function notifyToolsChanged(): Promise<void> {
  try {
    await server.server.sendToolListChanged();
  } catch {
    // Client may not support notifications yet
  }
}

bundler.on('connected', async () => {
  await bundler.registerTools(server);
  await notifyToolsChanged();
});

bundler.on('disconnected', async () => {
  bundler.unregisterTools(server);
  await notifyToolsChanged();
});

bundler.on('tools_changed', async () => {
  bundler.unregisterTools(server);
  await bundler.registerTools(server);
  await notifyToolsChanged();
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Non-blocking — server is already running, bundler retries in background
bundler.connect().catch(() => {});
