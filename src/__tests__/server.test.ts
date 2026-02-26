import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import type { VariantScanner, VariantState } from '../scanner.js';
import { registerLaunchTool } from '../tools/launch.js';
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
      handler: (args: unknown) => Promise<unknown>;
    }
  >;
};

function createServer(): McpServer {
  return new McpServer(
    { name: 'test', version: '0.0.1' },
    { capabilities: { tools: { listChanged: true } } },
  );
}

function mockScanner(states: Record<string, VariantState>): VariantScanner {
  return {
    getStates: () => new Map(Object.entries(states)),
  } as unknown as VariantScanner;
}

describe('built-in tools registration', () => {
  it('kunobi_status has correct annotations', () => {
    const server = createServer();
    const scanner = mockScanner({});
    registerStatusTool(server, scanner);

    const tool = (server as unknown as ServerInternals)._registeredTools
      .kunobi_status;
    expect(tool.annotations).toBeDefined();
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.annotations?.destructiveHint).toBe(false);
    expect(tool.annotations?.openWorldHint).toBe(false);
  });

  it('kunobi_launch is registered', () => {
    const server = createServer();
    registerLaunchTool(server);

    const tool = (server as unknown as ServerInternals)._registeredTools
      .kunobi_launch;
    expect(tool).toBeDefined();
  });
});
