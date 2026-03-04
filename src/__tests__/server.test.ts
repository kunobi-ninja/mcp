import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import type { VariantScanner, VariantState } from '../scanner.js';
import { registerLaunchTool } from '../tools/launch.js';
import { registerRefreshTool } from '../tools/refresh.js';
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
  _registeredResources: Record<string, unknown>;
};

function createServer(): McpServer {
  return new McpServer(
    { name: 'test', version: '0.0.1' },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
      },
    },
  );
}

function mockScanner(states: Record<string, VariantState>): VariantScanner {
  return {
    getStates: () => new Map(Object.entries(states)),
    scan: async () => {},
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

  it('kunobi_refresh is registered with correct annotations', () => {
    const server = createServer();
    const scanner = mockScanner({});
    registerRefreshTool(server, scanner);

    const tool = (server as unknown as ServerInternals)._registeredTools
      .kunobi_refresh;
    expect(tool).toBeDefined();
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.annotations?.destructiveHint).toBe(false);
  });
});

describe('resource registration', () => {
  it('kunobi_status resource can be registered', () => {
    const server = createServer();
    const scanner = mockScanner({});

    server.registerResource(
      'kunobi_status',
      'kunobi://status',
      {
        description: 'Current Kunobi connection state',
        mimeType: 'application/json',
      },
      async () => {
        const states: Record<string, unknown> = {};
        for (const [variant, state] of scanner.getStates()) {
          states[variant] = state;
        }
        return {
          contents: [
            {
              uri: 'kunobi://status',
              mimeType: 'application/json',
              text: JSON.stringify({ variants: states }, null, 2),
            },
          ],
        };
      },
    );

    const resources = (server as unknown as ServerInternals)
      ._registeredResources;
    expect(resources['kunobi://status']).toBeDefined();
  });
});
