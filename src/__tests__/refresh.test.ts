import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import type { VariantScanner, VariantState } from '../scanner.js';
import { registerRefreshTool } from '../tools/refresh.js';

vi.mock('../discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../discovery.js')>();
  return { ...actual, findKunobiVariants: vi.fn().mockReturnValue([]) };
});

import { findKunobiVariants } from '../discovery.js';

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

function mockScanner(states: Record<string, VariantState>): VariantScanner {
  return {
    getStates: () => new Map(Object.entries(states)),
    scan: vi.fn().mockResolvedValue(undefined),
  } as unknown as VariantScanner;
}

function getHandler(server: McpServer) {
  return (server as unknown as ServerInternals)._registeredTools.kunobi_refresh
    .handler;
}

describe('registerRefreshTool', () => {
  it('registers with correct annotations', () => {
    const server = createServer();
    const scanner = mockScanner({});
    registerRefreshTool(server, scanner);

    const tool = (server as unknown as ServerInternals)._registeredTools
      .kunobi_refresh;
    expect(tool).toBeDefined();
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.annotations?.destructiveHint).toBe(false);
  });

  it('calls scanner.scan() when invoked', async () => {
    const server = createServer();
    const scanner = mockScanner({});
    registerRefreshTool(server, scanner);

    await getHandler(server)({});
    expect(scanner.scan).toHaveBeenCalled();
  });

  it('reports connected variants in result', async () => {
    const server = createServer();
    const scanner = mockScanner({
      dev: {
        port: 3400,
        status: 'connected',
        tools: ['dev__foo', 'dev__bar'],
      },
    });
    registerRefreshTool(server, scanner);

    const result = await getHandler(server)({});
    const text = result.content[0].text;
    expect(text).toContain('Scan complete');
    expect(text).toContain('dev');
    expect(text).toContain('connected');
    expect(text).toContain('2 tools');
  });

  it('reports not_detected variants', async () => {
    const server = createServer();
    const scanner = mockScanner({
      stable: { port: 3200, status: 'not_detected', tools: [] },
    });
    registerRefreshTool(server, scanner);

    const result = await getHandler(server)({});
    expect(result.content[0].text).toContain('not detected');
  });

  it('reports connecting variants', async () => {
    const server = createServer();
    const scanner = mockScanner({
      dev: { port: 3400, status: 'connecting', tools: [] },
    });
    registerRefreshTool(server, scanner);

    const result = await getHandler(server)({});
    expect(result.content[0].text).toContain('connecting...');
  });

  it('reports disconnected variants', async () => {
    const server = createServer();
    const scanner = mockScanner({
      dev: { port: 3400, status: 'disconnected', tools: [] },
    });
    registerRefreshTool(server, scanner);

    const result = await getHandler(server)({});
    expect(result.content[0].text).toContain('disconnected (reconnecting)');
  });

  it('includes installed variants when found', async () => {
    vi.mocked(findKunobiVariants).mockReturnValue(['Kunobi', 'Kunobi Dev']);
    const server = createServer();
    const scanner = mockScanner({
      dev: { port: 3400, status: 'connected', tools: [] },
    });
    registerRefreshTool(server, scanner);

    const result = await getHandler(server)({});
    expect(result.content[0].text).toContain('Installed on system');
    expect(result.content[0].text).toContain('Kunobi, Kunobi Dev');
  });
});
