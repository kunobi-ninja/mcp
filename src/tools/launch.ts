import { spawn } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { findKunobiVariants, getLaunchCommand } from '../discovery.js';

export function registerLaunchTool(server: McpServer): void {
  server.registerTool(
    'kunobi_launch',
    {
      description:
        'Launch the Kunobi desktop app. Optionally specify which variant to launch (e.g. "Kunobi Dev"). If omitted, launches the first installed variant.',
      inputSchema: {
        variant: z
          .string()
          .optional()
          .describe(
            'Which Kunobi variant to launch, e.g. "Kunobi", "Kunobi Dev"',
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ variant }) => {
      const variants = findKunobiVariants();

      if (variants.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Kunobi is not installed. Download it from https://kunobi.ninja/downloads',
            },
          ],
          isError: true,
        };
      }

      const target = variant ?? variants[0];

      if (!variants.includes(target)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Variant "${target}" is not installed. Available: ${variants.join(', ')}`,
            },
          ],
          isError: true,
        };
      }

      const launch = getLaunchCommand(target);
      if (!launch) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Could not determine how to launch "${target}" on this platform.`,
            },
          ],
          isError: true,
        };
      }

      const child = spawn(launch.command, launch.args, {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      return {
        content: [
          {
            type: 'text' as const,
            text: `Launching ${target}. It may take a few seconds for MCP to become available.`,
          },
        ],
      };
    },
  );
}
