import type { VariantManager } from './manager.js';

/** The subset of `ProxyRegistry` this catalog depends on — kept narrow so
 *  tests can supply a fake without constructing a real registry. */
export interface ProxySnapshotProvider {
  snapshot(): Array<{
    variant: string;
    uuid: string;
    name: string;
    tools: Array<{
      originalTool: string;
      dynamicToolName: string;
      directlyRegistered: boolean;
    }>;
  }>;
}

export function buildDiscoveryCatalog(
  manager: VariantManager,
  proxyRegistry: ProxySnapshotProvider,
): {
  callTool: 'kunobi_call';
  callShape: {
    variant: string;
    tool: string;
    arguments: Record<string, unknown>;
  };
  variants: Record<string, unknown>;
  proxies: {
    note: string;
    entries: Array<{
      variant: string;
      proxy_uuid: string;
      name: string;
      tools: Array<{
        originalTool: string;
        dynamicToolName: string;
        directlyRegistered: boolean;
      }>;
    }>;
  };
} {
  const variants: Record<string, unknown> = {};

  for (const [variant, entry] of manager.getCatalog()) {
    variants[variant] = {
      port: entry.port,
      status: entry.status,
      tools: entry.tools.map((tool) => ({
        ...tool,
        dynamicToolName: `${variant}__${tool.name}`,
      })),
      resources: entry.resources,
      prompts: entry.prompts.map((prompt) => ({
        ...prompt,
        dynamicPromptName: `${variant}__${prompt.name}`,
      })),
    };
  }

  const proxyEntries = proxyRegistry.snapshot().map((entry) => ({
    variant: entry.variant,
    proxy_uuid: entry.uuid,
    name: entry.name,
    tools: entry.tools,
  }));

  return {
    callTool: 'kunobi_call',
    callShape: {
      variant: 'dev',
      tool: 'k8s',
      arguments: { action: 'list', variant: 'events' },
    },
    variants,
    proxies: {
      note: "Extension-contributed MCP proxies, addressed via kunobi_call(variant, tool, proxy_uuid, arguments). Tools with directlyRegistered:false are NOT registered as standalone MCP tools (to avoid name collisions) — they are reachable ONLY via kunobi_call, passing this entry's proxy_uuid and the tool's originalTool as `tool`.",
      entries: proxyEntries,
    },
  };
}
