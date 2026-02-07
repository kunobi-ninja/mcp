import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { detectKunobi, type KunobiState, launchHint } from '../discovery.js';

function formatStatus(state: KunobiState): string {
  switch (state.status) {
    case 'not_installed':
      return [
        'Kunobi is not installed.',
        '',
        'Download from: https://kunobi.ninja/downloads',
      ].join('\n');

    case 'installed_not_running':
      return [
        `Kunobi is installed but not running. Found: ${state.variants.join(', ')}.`,
        '',
        launchHint(),
      ].join('\n');

    case 'running_mcp_unreachable':
      return [
        `Kunobi is running (PID ${state.pid}) but MCP server is not reachable.`,
        '',
        'Make sure MCP is enabled in Kunobi Settings.',
      ].join('\n');

    case 'connected': {
      const lines = [
        `Connected to Kunobi${state.pid ? ` (PID ${state.pid})` : ''}.`,
        `${state.tools.length} tools available: ${state.tools.join(', ')}`,
      ];
      if (state.variants.length > 0) {
        lines.push(`Installed variants: ${state.variants.join(', ')}`);
      }
      return lines.join('\n');
    }
  }
}

export function registerStatusTool(server: McpServer): void {
  server.registerTool(
    'kunobi_status',
    {
      description:
        'Check the connection status of Kunobi desktop app. Returns whether Kunobi is installed, running, and what tools are available.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const state = await detectKunobi();
      return {
        content: [{ type: 'text' as const, text: formatStatus(state) }],
      };
    },
  );
}
