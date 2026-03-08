import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DEFAULT_CONFIG_PATH } from '../config.js';
import { findKunobiVariants } from '../discovery.js';
import type { VariantManager } from '../manager.js';

function formatMultiStatus(manager: VariantManager): string {
  const states = manager.getStates();
  const lines: string[] = [
    'Kunobi MCP Hub Status',
    '─────────────────────',
    'Variants:',
  ];

  for (const [variant, state] of states) {
    const icon = state.status === 'connected' ? '✓' : '✗';
    const detail =
      state.status === 'connected'
        ? `connected, ${state.tools.length} tools`
        : state.status === 'connecting'
          ? 'connecting...'
          : state.status === 'disconnected'
            ? 'disconnected (reconnecting)'
            : 'not running';
    lines.push(
      `  ${icon} ${variant.padEnd(10)} (port ${state.port}) — ${detail}`,
    );
  }

  const installed = findKunobiVariants();
  if (installed.length > 0) {
    lines.push('', `Installed on system: ${installed.join(', ')}`);
  }

  const lastRefresh = manager.getLastRefreshTime();
  if (lastRefresh) {
    const agoMs = Date.now() - lastRefresh.getTime();
    const agoSec = Math.round(agoMs / 1000);
    lines.push(`Last refresh: ${agoSec}s ago`);
  }

  if (manager.isRunning()) {
    lines.push(
      `Reconnect interval: ${Math.round(manager.getReconnectIntervalMs() / 1000)}s`,
    );
  } else {
    lines.push(
      'Auto-connect: disabled (call kunobi_refresh to connect manually)',
    );
  }

  lines.push('', `Config: ${DEFAULT_CONFIG_PATH}`);

  return lines.join('\n');
}

export function registerStatusTool(
  server: McpServer,
  manager: VariantManager,
): void {
  server.registerTool(
    'kunobi_status',
    {
      description:
        "Check which Kunobi variants are currently connected to this hub. Reports each variant's port, connection status, available tools, and reconnect timing. Call this before using Kunobi tools to understand what's available.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      return {
        content: [{ type: 'text' as const, text: formatMultiStatus(manager) }],
      };
    },
  );
}
