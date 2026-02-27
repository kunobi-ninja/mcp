import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findKunobiVariants } from '../discovery.js';
import type { VariantScanner } from '../scanner.js';

function formatRefreshResult(scanner: VariantScanner): string {
  const states = scanner.getStates();
  const lines: string[] = ['Scan complete. Current status:'];

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

  return lines.join('\n');
}

export function registerRefreshTool(
  server: McpServer,
  scanner: VariantScanner,
): void {
  server.registerTool(
    'kunobi_refresh',
    {
      description:
        'Force an immediate rescan of all Kunobi variant ports. Use this after launching Kunobi or when kunobi_status shows stale data. Returns the fresh connection status for all variants.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      await scanner.scan();
      return {
        content: [
          { type: 'text' as const, text: formatRefreshResult(scanner) },
        ],
      };
    },
  );
}
