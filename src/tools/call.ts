import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { VariantManager } from '../manager.js';

/** The subset of `ProxyUpstream` this tool depends on — kept narrow so tests
 *  can supply a fake without constructing a real upstream. */
export interface ProxyCallerEntry {
  callTool(
    originalTool: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult | null>;
}

/** The subset of `ProxyRegistry` this tool depends on — kept narrow so tests
 *  can supply a fake without constructing a real registry. */
export interface ProxyCaller {
  get(variant: string, uuid: string): ProxyCallerEntry | undefined;
  snapshot(): Array<{ variant: string; uuid: string }>;
}

export function registerCallTool(
  server: McpServer,
  manager: VariantManager,
  proxyRegistry: ProxyCaller,
): void {
  server.registerTool(
    'kunobi_call',
    {
      description:
        'Stable tool entrypoint for Kunobi operations. Call a variant tool via (variant, tool, arguments), e.g. variant="dev", tool="k8s". For a proxied extension MCP tool (directlyRegistered:false in kunobi://tools), also pass proxy_uuid to address it by its stable (variant, proxy_uuid) identity, with tool set to its ORIGINAL (un-namespaced) name. Use kunobi://tools to discover full downstream tool schemas and metadata.',
      inputSchema: {
        variant: z
          .string()
          .describe('Kunobi variant name, e.g. "dev", "stable", "local".'),
        tool: z
          .string()
          .describe(
            'Remote tool name without variant prefix, e.g. "k8s". When proxy_uuid is set, this is the ORIGINAL tool name from that proxy (not the namespaced dynamicToolName).',
          ),
        proxy_uuid: z
          .string()
          .optional()
          .describe(
            "Optional stable address for a proxied extension MCP tool, from kunobi://tools' proxies section. When set, dispatches to the (variant, proxy_uuid) upstream instead of the regular variant-tool path.",
          ),
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
    async ({ variant, tool, proxy_uuid, arguments: args }) => {
      if (proxy_uuid !== undefined) {
        const entry = proxyRegistry.get(variant, proxy_uuid);

        if (!entry) {
          const available = proxyRegistry
            .snapshot()
            .map((e) => `(${e.variant}, ${e.uuid})`)
            .join(', ');
          return {
            content: [
              {
                type: 'text' as const,
                text: `Unknown proxy address (variant="${variant}", proxy_uuid="${proxy_uuid}"). Available (variant, proxy_uuid) addresses: ${available || 'none'}`,
              },
            ],
            isError: true,
          };
        }

        const proxyResult = await entry.callTool(tool, args ?? {});

        if (!proxyResult) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Proxy (variant="${variant}", proxy_uuid="${proxy_uuid}") is no longer available (it may have just been revoked). Run kunobi_refresh, then re-read kunobi://tools.`,
              },
            ],
            isError: true,
          };
        }

        return proxyResult;
      }

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
