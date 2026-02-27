import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findKunobiVariants } from '../discovery.js';
import type { VariantScanner } from '../scanner.js';

function formatMultiStatus(scanner: VariantScanner): string {
  const states = scanner.getStates();
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
            : 'not detected';
    lines.push(
      `  ${icon} ${variant.padEnd(10)} (port ${state.port}) — ${detail}`,
    );
  }

  const installed = findKunobiVariants();
  if (installed.length > 0) {
    lines.push('', `Installed on system: ${installed.join(', ')}`);
  }

  const lastScan = scanner.getLastScanTime();
  if (lastScan) {
    const agoMs = Date.now() - lastScan.getTime();
    const agoSec = Math.round(agoMs / 1000);
    lines.push(`Last scanned: ${agoSec}s ago`);
  }

  return lines.join('\n');
}

export function registerStatusTool(
  server: McpServer,
  scanner: VariantScanner,
): void {
  server.registerTool(
    'kunobi_status',
    {
      description:
        "Check which Kunobi variants are currently connected to this hub. Reports each variant's port, connection status, available tools, and when the last scan occurred. Call this before using Kunobi tools to understand what's available.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      return {
        content: [{ type: 'text' as const, text: formatMultiStatus(scanner) }],
      };
    },
  );
}
