import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { detectKunobi, type KunobiState } from '../discovery.js';

function formatStatus(state: KunobiState): string {
  switch (state.status) {
    case 'not_installed':
      return [
        'Kunobi is not installed.',
        '',
        'Download from: https://kunobi.ninja',
      ].join('\n');

    case 'installed_not_running':
      return [
        'Kunobi is installed but not running.',
        '',
        'Launch it from your Applications folder.',
      ].join('\n');

    case 'running_mcp_unreachable':
      return [
        `Kunobi is running (PID ${state.pid}) but MCP server is not reachable.`,
        '',
        'Make sure MCP is enabled in Kunobi Settings.',
      ].join('\n');

    case 'connected':
      return [
        `Connected to Kunobi${state.pid ? ` (PID ${state.pid})` : ''}.`,
        `${state.tools.length} tools available: ${state.tools.join(', ')}`,
      ].join('\n');
  }
}

export function registerStatusTool(server: McpServer): void {
  server.registerTool(
    'kunobi_status',
    {
      description:
        'Check the connection status of Kunobi desktop app. Returns whether Kunobi is installed, running, and what tools are available.',
    },
    async () => {
      const state = await detectKunobi();
      return {
        content: [{ type: 'text' as const, text: formatStatus(state) }],
      };
    },
  );
}
