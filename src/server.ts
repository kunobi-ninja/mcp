#!/usr/bin/env node

import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { findKunobiVariants, getScanConfig, launchHint } from './discovery.js';
import { VariantScanner } from './scanner.js';
import { registerLaunchTool } from './tools/launch.js';
import { registerRefreshTool } from './tools/refresh.js';
import { registerStatusTool } from './tools/status.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const arg = process.argv[2];
if (arg === '--help' || arg === '-h') {
  console.log(`Kunobi MCP server v${version} — connects AI assistants to the Kunobi desktop app.

Commands:
  --install, -i       Register this MCP server with your AI clients
  --uninstall, -u     Remove this MCP server from your AI clients
  --help, -h          Show this help message
  --version, -v       Show version number

Environment:
  MCP_KUNOBI_INTERVAL       Scan interval in ms (default: 5000)
  MCP_KUNOBI_PORTS          Comma-separated port filter (default: all known)
  MCP_KUNOBI_ENABLED        Set "false" to disable scanning
  MCP_KUNOBI_MISS_THRESHOLD Misses before teardown (default: 3)`);
  process.exit(0);
}

if (arg === '--version' || arg === '-v') {
  console.log(version);
  process.exit(0);
}

if (arg === '--install' || arg === '-i') {
  const { install } = await import('@kunobi/mcp-installer');
  await install({
    name: 'kunobi',
    command: 'npx',
    args: ['-y', '@kunobi/mcp'],
  });
  process.exit(0);
}

if (arg === '--uninstall' || arg === '-u') {
  const { uninstall } = await import('@kunobi/mcp-installer');
  await uninstall({ name: 'kunobi' });
  process.exit(0);
}

const scanConfig = getScanConfig();

const server = new McpServer(
  { name: 'kunobi', version },
  {
    capabilities: { tools: { listChanged: true }, logging: {} },
    instructions: [
      'Kunobi is a platform engineering desktop app (https://kunobi.ninja). This MCP server is a hub that automatically discovers and connects to running Kunobi instances. Multiple variants may run simultaneously (legacy, stable, unstable, dev, etc.), each on a dedicated port.',
      '',
      'When a Kunobi variant connects, its tools are registered here with a prefixed name: e.g. a tool "get_pod_logs" from the "dev" variant appears as "dev__get_pod_logs". Tools appear and disappear dynamically as Kunobi variants start and stop.',
      '',
      'If Kunobi is not installed, it can be downloaded from https://kunobi.ninja/downloads',
      '',
      'Available hub tools:',
      "- kunobi_status: Check which variants are connected and when the last scan occurred. Call this first to understand what's available.",
      '- kunobi_launch: Start the Kunobi desktop app if no variants are detected.',
      '- kunobi_refresh: Force an immediate rescan of all variant ports. Use after launching Kunobi or when kunobi_status shows stale data.',
      '',
      'Typical workflow:',
      "1. Call kunobi_status to see what's connected",
      '2. If nothing is connected, call kunobi_launch then kunobi_refresh',
      '3. Use the variant-prefixed tools (e.g. stable__get_pod_logs) for operations',
    ].join('\n'),
  },
);

const scanner = new VariantScanner(server, {
  ports: scanConfig.ports,
  intervalMs: scanConfig.intervalMs,
  missThreshold: scanConfig.missThreshold,
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

registerStatusTool(server, scanner);
registerRefreshTool(server, scanner);
registerLaunchTool(server);

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
    for (const [variant, state] of scanner.getStates()) {
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
              scanInterval: scanConfig.intervalMs,
            },
            null,
            2,
          ),
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
    const states = scanner.getStates();
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
      instructions = `Kunobi is installed but no variants are running (found: ${installed.join(', ')}). ${launchHint()} Use kunobi_launch to start it, then kunobi_refresh to detect it immediately.`;
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
    const states = scanner.getStates();
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
          'No Kunobi variants detected.',
          '1. Download Kunobi from https://kunobi.ninja/downloads',
          '2. Install and launch the application',
          '3. Enable MCP in Kunobi Settings',
        );
      } else {
        steps.push(
          `Kunobi is installed (${installed.join(', ')}) but no variants are running.`,
          `1. ${launchHint()} Or call kunobi_launch.`,
          '2. Call kunobi_refresh to detect the new instance immediately',
          '3. Tools will appear automatically once connected',
        );
      }
    }

    steps.push(
      '',
      `Scanning ports: ${[...states.entries()].map(([v, s]) => `${v}:${s.port}`).join(', ')}`,
    );
    steps.push(`Scan interval: ${scanConfig.intervalMs}ms`);

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

// Start scanning — non-blocking, bundlers connect in background
scanner.start();

// Graceful shutdown — close bundlers and transport on termination
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const timeout = setTimeout(() => process.exit(1), 5_000);
  try {
    await scanner.stop();
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
