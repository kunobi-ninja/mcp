import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { VariantManager } from '../manager.js';

export function registerCallTool(
  server: McpServer,
  manager: VariantManager,
): void {
  server.registerTool(
    'kunobi_call',
    {
      description:
        'Stable tool entrypoint for Kunobi operations. Call a variant tool via (variant, tool, arguments), e.g. variant="dev", tool="k8s". Use kunobi://tools to discover full downstream tool schemas and metadata.',
      inputSchema: {
        variant: z
          .string()
          .describe('Kunobi variant name, e.g. "dev", "stable", "local".'),
        tool: z
          .string()
          .describe('Remote tool name without variant prefix, e.g. "k8s".'),
        arguments: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Arguments object passed to the target variant tool. Match the selected tool inputSchema from kunobi://tools.',
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ variant, tool, arguments: args }) => {
      const states = manager.getStates();

      if (!states.has(variant)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Unknown variant "${variant}". Available variants: ${[...states.keys()].join(', ')}`,
            },
          ],
          isError: true,
        };
      }

      const result = await manager.callVariantTool(
        variant,
        tool,
        (args ?? {}) as Record<string, unknown>,
      );

      if (!result) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Variant "${variant}" is no longer available. Use kunobi_status/kunobi_refresh first.`,
            },
          ],
          isError: true,
        };
      }

      return result;
    },
  );
}
