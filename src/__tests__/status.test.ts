import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import type { VariantScanner, VariantState } from '../scanner.js';
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

function mockScanner(states: Record<string, VariantState>): VariantScanner {
  return {
    getStates: () => new Map(Object.entries(states)),
    getLastScanTime: () => null,
  } as unknown as VariantScanner;
}

describe('registerStatusTool (multi-variant)', () => {
  it('registers kunobi_status tool on the server', () => {
    const server = createServer();
    const scanner = mockScanner({});
    registerStatusTool(server, scanner);

    const tool = (server as unknown as ServerInternals)._registeredTools
      .kunobi_status;
    expect(tool).toBeDefined();
    expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it('reports connected variants', async () => {
    const server = createServer();
    const scanner = mockScanner({
      dev: { port: 3400, status: 'connected', tools: ['dev__foo', 'dev__bar'] },
      e2e: { port: 3600, status: 'not_detected', tools: [] },
    });
    registerStatusTool(server, scanner);

    const tool = (server as unknown as ServerInternals)._registeredTools
      .kunobi_status;
    const result = await tool.handler({});
    expect(result.content[0].text).toContain('dev');
    expect(result.content[0].text).toContain('3400');
    expect(result.content[0].text).toContain('connected');
    expect(result.content[0].text).toContain('e2e');
    expect(result.content[0].text).toContain('not detected');
  });

  it('includes last scanned timestamp', async () => {
    const server = createServer();
    const lastScan = new Date(Date.now() - 3000);
    const scanner = {
      ...mockScanner({
        dev: { port: 3400, status: 'connected', tools: ['dev__foo'] },
      }),
      getLastScanTime: () => lastScan,
    } as unknown as VariantScanner;
    registerStatusTool(server, scanner);

    const tool = (server as unknown as ServerInternals)._registeredTools
      .kunobi_status;
    const result = await tool.handler({});
    expect(result.content[0].text).toContain('Last scanned:');
    expect(result.content[0].text).toContain('ago');
  });
});
