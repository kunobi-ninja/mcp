import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import type { VariantManager, VariantState } from '../manager.js';
import { registerCallTool } from '../tools/call.js';

type RegisteredTool = {
  handler: (args: unknown) => Promise<{
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }>;
};

type ServerInternals = {
  _registeredTools: Record<string, RegisteredTool | undefined>;
};

function createServer(): McpServer {
  return new McpServer(
    { name: 'test', version: '0.0.1' },
    { capabilities: { tools: { listChanged: true } } },
  );
}

function mockManager(
  states: Record<string, VariantState>,
  callVariantTool = vi.fn(),
): VariantManager {
  return {
    getStates: () => new Map(Object.entries(states)),
    getCatalog: () =>
      new Map(
        Object.entries(states).map(([variant, state]) => [
          variant,
          {
            port: state.port,
            status: state.status,
            tools: state.tools.map((name) => ({
              name: name.startsWith(`${variant}__`)
                ? name.slice(`${variant}__`.length)
                : name,
              inputSchema: { type: 'object' as const },
            })),
            resources: [],
            prompts: [],
          },
        ]),
      ),
    callVariantTool,
  } as unknown as VariantManager;
}

describe('registerCallTool', () => {
  it('returns error for unknown variant', async () => {
    const server = createServer();
    const manager = mockManager({});
    registerCallTool(server, manager);

    const tool = (server as unknown as ServerInternals)._registeredTools
      .kunobi_call;

    if (!tool) {
      throw new Error('kunobi_call should be registered');
    }

    const result = await tool.handler({
      variant: 'dev',
      tool: 'k8s',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown variant');
  });

  it('forwards call to the variant-prefixed tool', async () => {
    const server = createServer();
    const callVariantTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text' as const, text: 'forwarded:list' }],
    });
    const manager = mockManager(
      {
        dev: { port: 3400, status: 'connected', tools: ['dev__k8s'] },
      },
      callVariantTool,
    );

    registerCallTool(server, manager);
    const tool = (server as unknown as ServerInternals)._registeredTools
      .kunobi_call;

    if (!tool) {
      throw new Error('kunobi_call should be registered');
    }

    const result = await tool.handler({
      variant: 'dev',
      tool: 'k8s',
      arguments: { action: 'list' },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('forwarded:list');
    expect(callVariantTool).toHaveBeenCalledWith('dev', 'k8s', {
      action: 'list',
    });
  });
});
