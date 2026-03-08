#!/usr/bin/env node

import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildDiscoveryCatalog } from './catalog.js';
import {
  findKunobiVariants,
  getConnectionConfig,
  launchHint,
} from './discovery.js';
import { VariantManager } from './manager.js';
import { registerCallTool } from './tools/call.js';
import { registerLaunchTool } from './tools/launch.js';
import { registerRefreshTool } from './tools/refresh.js';
import { registerStatusTool } from './tools/status.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const arg = process.argv[2];
const HELP = `Kunobi MCP server v${version} — connects AI assistants to the Kunobi desktop app.

Usage:
  kunobi-mcp                        MCP server (when stdin is piped by an AI client)
  kunobi-mcp list                   Show configured variants and connection status
  kunobi-mcp add <name> <port>      Add or update a variant
  kunobi-mcp remove <name>          Remove a variant
  kunobi-mcp install                Register this MCP server with your AI clients
  kunobi-mcp uninstall              Remove this MCP server from your AI clients

Options:
  --help, -h          Show this help message
  --version, -v       Show version number

Configuration:
  Config file: ~/.config/kunobi/mcp.json (auto-generated on first run)

Environment:
  MCP_KUNOBI_RECONNECT_INTERVAL_MS   Reconnect interval in ms (default: 5000)
  MCP_KUNOBI_VARIANTS                name:port pairs to merge (e.g. juan:4200,test:5000)
  MCP_KUNOBI_AUTO_CONNECT            Set "false" to disable automatic background connections`;

if (arg === '--help' || arg === '-h') {
  console.log(HELP);
  process.exit(0);
}

if (arg === '--version' || arg === '-v') {
  console.log(version);
  process.exit(0);
}

if (arg === 'list') {
  const { runList } = await import('./cli.js');
  await runList();
  process.exit(0);
}

if (arg === 'add') {
  const name = process.argv[3];
  const port = Number(process.argv[4]);
  if (!name || Number.isNaN(port)) {
    console.error('Usage: kunobi-mcp add <name> <port>');
    process.exit(1);
  }
  const { runAdd } = await import('./cli.js');
  runAdd(name, port);
  process.exit(0);
}

if (arg === 'remove') {
  const name = process.argv[3];
  if (!name) {
    console.error('Usage: kunobi-mcp remove <name>');
    process.exit(1);
  }
  const { runRemove } = await import('./cli.js');
  runRemove(name);
  process.exit(0);
}

if (arg === 'install' || arg === '--install' || arg === '-i') {
  const { install } = await import('@kunobi/mcp-installer');
  await install({
    name: 'kunobi',
    command: 'npx',
    args: ['-y', '@kunobi/mcp'],
  });
  process.exit(0);
}

if (arg === 'uninstall' || arg === '--uninstall' || arg === '-u') {
  const { uninstall } = await import('@kunobi/mcp-installer');
  await uninstall({ name: 'kunobi' });
  process.exit(0);
}

const connectionConfig = getConnectionConfig();

const server = new McpServer(
  { name: 'kunobi', version },
  {
    capabilities: {
      tools: { listChanged: true },
      resources: { subscribe: true, listChanged: true },
      prompts: { listChanged: true },
      logging: {},
    },
    instructions: [
      'Kunobi is a platform engineering desktop app (https://kunobi.ninja). This MCP server is a hub that automatically discovers and connects to running Kunobi instances. Multiple variants may run simultaneously (legacy, stable, unstable, dev, etc.), each on a dedicated port.',
      '',
      'When a Kunobi variant connects, its tools are registered here with a prefixed name: e.g. a tool "get_pod_logs" from the "dev" variant appears as "dev__get_pod_logs". Tools appear and disappear dynamically as Kunobi variants start and stop.',
      '',
      'If Kunobi is not installed, it can be downloaded from https://kunobi.ninja/downloads',
      '',
      'Configuration: Variant ports are loaded from ~/.config/kunobi/mcp.json (auto-generated). Custom variants can be added by editing this file or setting MCP_KUNOBI_VARIANTS with name:port pairs.',
      '',
      'Available stable hub tools:',
      "- kunobi_status: Check which variants are connected, their reconnect state, and whether automatic background connections are enabled. Call this first to understand what's available.",
      '- kunobi_launch: Start the Kunobi desktop app if no variants are detected.',
      '- kunobi_refresh: Force an immediate reconnect attempt across all configured variants. Use after launching Kunobi or when kunobi_status shows stale data.',
      '- kunobi_call: Stable entrypoint to call variant tools via (variant, tool, arguments).',
      '- kunobi://tools (resource): Discover full downstream tool metadata, schemas, prompts, and resources per variant.',
      '',
      'Recommended workflow:',
      "1. Call kunobi_status to see what's connected",
      '2. If nothing is connected, call kunobi_launch then kunobi_refresh',
      '3. Read kunobi://tools to discover downstream tool schemas and metadata',
      '4. Use kunobi_call for operations (primary stable path)',
      '5. Direct variant-prefixed tools (e.g. stable__get_pod_logs) are optional and may not refresh in all clients',
    ].join('\n'),
  },
);

const manager = new VariantManager(server, {
  ports: connectionConfig.ports,
  reconnectIntervalMs: connectionConfig.reconnectIntervalMs,
  autoReconnect: connectionConfig.autoConnect,
  logger: (level, message) => {
    if (level === 'error' || level === 'warn') {
      server.server
        .sendLoggingMessage({
          level: level === 'error' ? 'error' : 'warning',
          logger: 'kunobi-mcp',
          data: message,
        })
        .catch(() => {});
    }
  },
});

registerStatusTool(server, manager);
registerRefreshTool(server, manager);
registerLaunchTool(server);
registerCallTool(server, manager);

// Resource: passive way for the LLM to check Kunobi state
server.registerResource(
  'kunobi_status',
  'kunobi://status',
  {
    description: 'Current Kunobi connection state across all variants',
    mimeType: 'application/json',
  },
  async () => {
    const states: Record<string, unknown> = {};
    for (const [variant, state] of manager.getStates()) {
      states[variant] = state;
    }
    return {
      contents: [
        {
          uri: 'kunobi://status',
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              variants: states,
              installedVariants: findKunobiVariants(),
              autoConnect: connectionConfig.autoConnect,
              reconnectIntervalMs: connectionConfig.reconnectIntervalMs,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerResource(
  'kunobi_tools',
  'kunobi://tools',
  {
    description:
      'Stable discovery resource for full downstream tool metadata and kunobi_call usage',
    mimeType: 'application/json',
  },
  async () => {
    return {
      contents: [
        {
          uri: 'kunobi://tools',
          mimeType: 'application/json',
          text: JSON.stringify(buildDiscoveryCatalog(manager), null, 2),
        },
      ],
    };
  },
);

// Prompt: guide user through Kunobi setup
server.registerPrompt(
  'kunobi-setup',
  { description: 'Check Kunobi status and provide setup instructions' },
  async () => {
    const states = manager.getStates();
    const connected = [...states.entries()].filter(
      ([, s]) => s.status === 'connected',
    );
    const installed = findKunobiVariants();

    let instructions: string;
    if (connected.length > 0) {
      const summary = connected
        .map(([v, s]) => `${v} (${s.tools.length} tools)`)
        .join(', ');
      instructions = `Kunobi is connected. Active variants: ${summary}.${installed.length > 0 ? ` Installed: ${installed.join(', ')}.` : ''}`;
    } else if (installed.length > 0) {
      instructions = `Kunobi is installed but no variants are running (found: ${installed.join(', ')}). ${launchHint()} Use kunobi_launch to start it, then kunobi_refresh to connect immediately.${connectionConfig.autoConnect ? '' : ' Automatic background connections are currently disabled.'}`;
    } else {
      instructions =
        'Kunobi is not installed. Download it from https://kunobi.ninja/downloads and install it on your system.';
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
    const states = manager.getStates();
    const installed = findKunobiVariants();
    const steps: string[] = [];

    const connected = [...states.entries()].filter(
      ([, s]) => s.status === 'connected',
    );
    const disconnected = [...states.entries()].filter(
      ([, s]) => s.status === 'disconnected',
    );

    if (connected.length > 0) {
      steps.push(`Connected variants: ${connected.map(([v]) => v).join(', ')}`);
    }
    if (disconnected.length > 0) {
      steps.push(
        `Disconnected (reconnecting): ${disconnected.map(([v]) => v).join(', ')}`,
      );
    }
    if (connected.length === 0 && disconnected.length === 0) {
      if (installed.length === 0) {
        steps.push(
          'No Kunobi variants are running.',
          '1. Download Kunobi from https://kunobi.ninja/downloads',
          '2. Install and launch the application',
          '3. Enable MCP in Kunobi Settings',
        );
      } else {
        steps.push(
          `Kunobi is installed (${installed.join(', ')}) but no variants are running.`,
          `1. ${launchHint()} Or call kunobi_launch.`,
          '2. Call kunobi_refresh to attempt a connection immediately',
          '3. Tools will appear automatically once connected',
        );
      }
    }

    if (!connectionConfig.autoConnect) {
      steps.push(
        '',
        'Automatic background connections are disabled via MCP_KUNOBI_AUTO_CONNECT=false.',
        'Call kunobi_refresh whenever you want to retry the configured Kunobi variants.',
      );
    }

    steps.push(
      '',
      `Configured variant ports: ${[...states.entries()].map(([v, s]) => `${v}:${s.port}`).join(', ')}`,
    );
    steps.push(`Reconnect interval: ${connectionConfig.reconnectIntervalMs}ms`);

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

const transport = new StdioServerTransport();
await server.connect(transport);

if (connectionConfig.autoConnect) {
  // Start the background connection manager after the MCP session is ready.
  manager.start();
} else {
  server.server
    .sendLoggingMessage({
      level: 'warning',
      logger: 'kunobi-mcp',
      data: 'Automatic background connections are disabled via MCP_KUNOBI_AUTO_CONNECT=false. Use kunobi_refresh to connect manually.',
    })
    .catch(() => {});
}

// Graceful shutdown — close bundlers and transport on termination
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const timeout = setTimeout(() => process.exit(1), 5_000);
  try {
    await manager.stop();
    await server.close();
  } catch {
    // Failing shutdown must not prevent exit
  }
  clearTimeout(timeout);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Non-blocking version check
import('@kunobi/mcp-installer')
  .then(({ checkForUpdate }) => checkForUpdate('@kunobi/mcp', version))
  .then((update) => {
    if (update?.updateAvailable) {
      server.server
        .sendLoggingMessage({
          level: 'warning',
          logger: 'kunobi-mcp',
          data: `A newer version of @kunobi/mcp is available (${update.current} → ${update.latest}). Restart the MCP server to pick it up.`,
        })
        .catch(() => {});
    }
  })
  .catch(() => {});
