#!/usr/bin/env node

import { createRequire } from 'node:module';
import { McpBundler } from '@kunobi/mcp-bundler';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { detectKunobi, getMcpUrl, launchHint } from './discovery.js';
import { registerLaunchTool } from './tools/launch.js';
import { registerStatusTool } from './tools/status.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const arg = process.argv[2];
if (arg === '--help' || arg === '-h') {
  console.log(`Kunobi MCP server v${version} — connects AI assistants to the Kunobi desktop app.

Usage (in Claude settings):
  {
    "mcpServers": {
      "kunobi": {
        "command": "npx",
        "args": ["@kunobi/mcp"]
      }
    }
  }

Options:
  --help, -h          Show this help message
  --version, -v       Show version number
  --install, -i       Register this MCP server with your AI clients
  --uninstall, -u     Remove this MCP server from your AI clients

Environment:
  KUNOBI_MCP_URL   Override Kunobi's MCP endpoint (default: http://127.0.0.1:3030/mcp)`);
  process.exit(0);
}

if (arg === '--version' || arg === '-v') {
  console.log(version);
  process.exit(0);
}

if (arg === '--install' || arg === '-i') {
  const { install } = await import('@kunobi/mcp-installer');
  await install({ name: 'kunobi', command: 'npx', args: ['@kunobi/mcp'] });
  process.exit(0);
}

if (arg === '--uninstall' || arg === '-u') {
  const { uninstall } = await import('@kunobi/mcp-installer');
  await uninstall({ name: 'kunobi' });
  process.exit(0);
}

const server = new McpServer(
  { name: 'kunobi', version },
  { capabilities: { tools: { listChanged: true }, logging: {} } },
);

registerStatusTool(server);
registerLaunchTool(server);

// Resource: passive way for the LLM to check Kunobi state
server.registerResource(
  'kunobi_status',
  'kunobi://status',
  {
    description: 'Current Kunobi connection state and available tools',
    mimeType: 'application/json',
  },
  async () => {
    const state = await detectKunobi();
    return {
      contents: [
        {
          uri: 'kunobi://status',
          mimeType: 'application/json',
          text: JSON.stringify(state, null, 2),
        },
      ],
    };
  },
);

// Prompt: guide user through Kunobi setup
server.registerPrompt(
  'kunobi-setup',
  {
    description: 'Check Kunobi status and provide setup instructions',
  },
  async () => {
    const state = await detectKunobi();
    let instructions: string;

    switch (state.status) {
      case 'not_installed':
        instructions =
          'Kunobi is not installed. Download it from https://kunobi.ninja/downloads and install it on your system.';
        break;
      case 'installed_not_running':
        instructions = `Kunobi is installed but not running (found: ${state.variants.join(', ')}). ${launchHint()}`;
        break;
      case 'running_mcp_unreachable':
        instructions = `Kunobi is running (PID ${state.pid}) but the MCP endpoint is not reachable. Open Kunobi Settings and make sure MCP is enabled.`;
        break;
      case 'connected':
        instructions = `Kunobi is connected and ready. ${state.tools.length} tools available: ${state.tools.join(', ')}.${state.variants.length > 0 ? ` Installed variants: ${state.variants.join(', ')}.` : ''}`;
        break;
    }

    return {
      messages: [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text: instructions },
        },
      ],
    };
  },
);

// Prompt: diagnose Kunobi connection issues
server.registerPrompt(
  'kunobi-doctor',
  {
    description: 'Diagnose why Kunobi tools are unavailable and suggest fixes',
  },
  async () => {
    const state = await detectKunobi();
    const steps: string[] = [];

    switch (state.status) {
      case 'not_installed':
        steps.push(
          'Kunobi is not installed on this system.',
          '1. Download Kunobi from https://kunobi.ninja/downloads',
          '2. Install and launch the application',
          '3. Enable MCP in Kunobi Settings',
        );
        break;
      case 'installed_not_running':
        steps.push(
          `Kunobi is installed but not running. Found variants: ${state.variants.join(', ')}.`,
          `1. ${launchHint()}`,
          '2. Wait a few seconds for MCP to initialize',
          '3. Tools will appear automatically once connected',
        );
        break;
      case 'running_mcp_unreachable':
        steps.push(
          `Kunobi is running (PID ${state.pid}) but the MCP endpoint is unreachable.`,
          '1. Open Kunobi Settings and verify MCP is enabled',
          `2. Check that the MCP endpoint is accessible at ${getMcpUrl()}`,
          '3. Try restarting Kunobi',
        );
        break;
      case 'connected':
        steps.push(
          'No issues detected — Kunobi is connected and working.',
          `${state.tools.length} tools available: ${state.tools.join(', ')}`,
        );
        break;
    }

    return {
      messages: [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text: steps.join('\n') },
        },
      ],
    };
  },
);

const CONNECTION_CHECK_AFTER = 6; // Check installation after ~30s (6 × 5s)
let failCount = 0;
let checkDone = false;

const bundler = new McpBundler({
  name: 'kunobi',
  url: getMcpUrl(),
  reconnect: {
    enabled: true,
    intervalMs: 5_000,
    maxRetries: Number.POSITIVE_INFINITY,
  },
  logger: (level: string) => {
    if (level === 'error') {
      failCount++;
      if (failCount >= CONNECTION_CHECK_AFTER && !checkDone) {
        checkDone = true;
        detectKunobi().then((state) => {
          let msg: string | undefined;
          switch (state.status) {
            case 'not_installed':
              msg =
                'Kunobi is not installed. Download it from https://kunobi.ninja/downloads';
              break;
            case 'installed_not_running':
              msg = `Kunobi is installed but not running (found: ${state.variants.join(', ')}). ${launchHint()}`;
              break;
            case 'running_mcp_unreachable':
              msg =
                'Kunobi is running but MCP is unreachable. Check that MCP is enabled in Kunobi Settings.';
              break;
          }
          if (msg) {
            server.server
              .sendLoggingMessage({
                level: 'warning',
                logger: 'kunobi-mcp',
                data: msg,
              })
              .catch(() => {});
          }
        });
      }
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
  failCount = 0;
  checkDone = false;
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
