import type { VariantManager } from './manager.js';

export function buildDiscoveryCatalog(manager: VariantManager): {
  callTool: 'kunobi_call';
  callShape: {
    variant: string;
    tool: string;
    arguments: Record<string, unknown>;
  };
  variants: Record<string, unknown>;
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

  return {
    callTool: 'kunobi_call',
    callShape: {
      variant: 'dev',
      tool: 'k8s',
      arguments: { action: 'list', variant: 'events' },
    },
    variants,
  };
}
