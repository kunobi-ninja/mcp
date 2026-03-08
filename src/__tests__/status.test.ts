import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import type { VariantManager, VariantState } from '../manager.js';
import { registerStatusTool } from '../tools/status.js';

type ServerInternals = {
  _registeredTools: Record<
    string,
    {
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        openWorldHint?: boolean;
      };
      handler: (args: unknown) => Promise<{
        content: Array<{ type: string; text: string }>;
      }>;
    }
  >;
};

function createServer(): McpServer {
  return new McpServer(
    { name: 'test', version: '0.0.1' },
    { capabilities: { tools: { listChanged: true } } },
  );
}

function mockManager(states: Record<string, VariantState>): VariantManager {
  return {
    getStates: () => new Map(Object.entries(states)),
    getLastRefreshTime: () => null,
    getReconnectIntervalMs: () => 5000,
    isRunning: () => true,
  } as unknown as VariantManager;
}

describe('registerStatusTool (multi-variant)', () => {
  it('registers kunobi_status tool on the server', () => {
    const server = createServer();
    const manager = mockManager({});
    registerStatusTool(server, manager);

    const tool = (server as unknown as ServerInternals)._registeredTools
      .kunobi_status;
    expect(tool).toBeDefined();
    expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it('reports connected variants', async () => {
    const server = createServer();
    const manager = mockManager({
      dev: { port: 3400, status: 'connected', tools: ['dev__foo', 'dev__bar'] },
      e2e: { port: 3600, status: 'not_running', tools: [] },
    });
    registerStatusTool(server, manager);

    const tool = (server as unknown as ServerInternals)._registeredTools
      .kunobi_status;
    const result = await tool.handler({});
    expect(result.content[0].text).toContain('dev');
    expect(result.content[0].text).toContain('3400');
    expect(result.content[0].text).toContain('connected');
    expect(result.content[0].text).toContain('e2e');
    expect(result.content[0].text).toContain('not running');
  });

  it('includes refresh timing details', async () => {
    const server = createServer();
    const lastRefresh = new Date(Date.now() - 3000);
    const manager = {
      ...mockManager({
        dev: { port: 3400, status: 'connected', tools: ['dev__foo'] },
      }),
      getLastRefreshTime: () => lastRefresh,
    } as unknown as VariantManager;
    registerStatusTool(server, manager);

    const tool = (server as unknown as ServerInternals)._registeredTools
      .kunobi_status;
    const result = await tool.handler({});
    expect(result.content[0].text).toContain('Last refresh:');
    expect(result.content[0].text).toContain('Reconnect interval: 5s');
    expect(result.content[0].text).toContain('ago');
  });

  it('reports when automatic background connections are disabled', async () => {
    const server = createServer();
    const manager = {
      ...mockManager({
        dev: { port: 3400, status: 'not_running', tools: [] },
      }),
      isRunning: () => false,
    } as unknown as VariantManager;
    registerStatusTool(server, manager);

    const tool = (server as unknown as ServerInternals)._registeredTools
      .kunobi_status;
    const result = await tool.handler({});
    expect(result.content[0].text).toContain('Auto-connect: disabled');
  });
});
