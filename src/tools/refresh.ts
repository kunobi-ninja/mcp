import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findKunobiVariants } from '../discovery.js';
import type { VariantManager } from '../manager.js';

/** The subset of `ProxyRegistry` this tool depends on — kept narrow so tests
 *  can supply a fake without constructing a real registry. */
export interface ProxyReconciler {
  reconcile(): Promise<void>;
}

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
  proxyRegistry: ProxyReconciler,
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
      // Coalescing guarantees this forced pass isn't dropped even if a
      // background poll is already reconciling proxies concurrently.
      await proxyRegistry.reconcile();
      return {
        content: [
          { type: 'text' as const, text: formatRefreshResult(manager) },
        ],
      };
    },
  );
}
