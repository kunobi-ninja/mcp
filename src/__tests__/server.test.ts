import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import type { VariantManager, VariantState } from '../manager.js';
import { registerCallTool } from '../tools/call.js';
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

function mockManager(states: Record<string, VariantState>): VariantManager {
  return {
    getStates: () => new Map(Object.entries(states)),
    refresh: async () => {},
  } as unknown as VariantManager;
}

describe('built-in tools registration', () => {
  it('kunobi_status has correct annotations', () => {
    const server = createServer();
    const manager = mockManager({});
    registerStatusTool(server, manager);

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
    const manager = mockManager({});
    registerRefreshTool(server, manager);

    const tool = (server as unknown as ServerInternals)._registeredTools
      .kunobi_refresh;
    expect(tool).toBeDefined();
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.annotations?.destructiveHint).toBe(false);
  });

  it('kunobi_call is registered', () => {
    const server = createServer();
    const manager = mockManager({});
    registerCallTool(server, manager);

    const tool = (server as unknown as ServerInternals)._registeredTools
      .kunobi_call;
    expect(tool).toBeDefined();
  });
});

describe('resource registration', () => {
  it('kunobi_status resource can be registered', () => {
    const server = createServer();
    const manager = mockManager({});

    server.registerResource(
      'kunobi_status',
      'kunobi://status',
      {
        description: 'Current Kunobi connection state',
        mimeType: 'application/json',
      },
      async () => {
        const states: Record<string, unknown> = {};
        for (const [variant, state] of manager.getStates()) {
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

  it('kunobi_tools resource can be registered', () => {
    const server = createServer();
    const manager = mockManager({
      dev: {
        port: 3400,
        status: 'connected',
        tools: ['dev__k8s', 'dev__store'],
      },
    });

    server.registerResource(
      'kunobi_tools',
      'kunobi://tools',
      {
        description: 'Stable discovery resource for variant tools',
        mimeType: 'application/json',
      },
      async () => {
        const variants: Record<string, unknown> = {};
        for (const [variant, state] of manager.getStates()) {
          variants[variant] = {
            port: state.port,
            status: state.status,
            tools: state.tools.map((name) =>
              name.startsWith(`${variant}__`)
                ? name.slice(`${variant}__`.length)
                : name,
            ),
          };
        }
        return {
          contents: [
            {
              uri: 'kunobi://tools',
              mimeType: 'application/json',
              text: JSON.stringify({ variants }, null, 2),
            },
          ],
        };
      },
    );

    const resources = (server as unknown as ServerInternals)
      ._registeredResources;
    expect(resources['kunobi://tools']).toBeDefined();
  });
});
