import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findKunobiVariants } from '../discovery.js';
import type { VariantManager } from '../manager.js';

function formatRefreshResult(manager: VariantManager): string {
  const states = manager.getStates();
  const lines: string[] = ['Refresh complete. Current status:'];

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

  return lines.join('\n');
}

export function registerRefreshTool(
  server: McpServer,
  manager: VariantManager,
): void {
  server.registerTool(
    'kunobi_refresh',
    {
      description:
        'Force an immediate reconnect attempt across all configured Kunobi variants. Use this after launching Kunobi or when kunobi_status shows stale data. Returns the fresh connection status for all variants.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      await manager.refresh();
      return {
        content: [
          { type: 'text' as const, text: formatRefreshResult(manager) },
        ],
      };
    },
  );
}
