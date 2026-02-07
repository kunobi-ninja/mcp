import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { registerStatusTool } from '../tools/status.js';

describe('registerStatusTool', () => {
  it('registers kunobi_status tool on the server', () => {
    const server = new McpServer(
      { name: 'test', version: '0.0.1' },
      { capabilities: { tools: { listChanged: true } } },
    );

    registerStatusTool(server);

    const serverAny = server as unknown as {
      _registeredTools: Record<string, unknown>;
    };
    expect(serverAny._registeredTools).toHaveProperty('kunobi_status');
  });

  it('tool handler returns a text content response', async () => {
    const server = new McpServer(
      { name: 'test', version: '0.0.1' },
      { capabilities: { tools: { listChanged: true } } },
    );

    registerStatusTool(server);

    const serverAny = server as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (args: unknown) => Promise<{
            content: Array<{ type: string; text: string }>;
          }>;
        }
      >;
    };
    const tool = serverAny._registeredTools.kunobi_status;
    expect(tool).toBeDefined();

    const result = await tool.handler({});
    expect(result).toHaveProperty('content');
    expect(result.content).toBeInstanceOf(Array);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0]).toHaveProperty('type', 'text');
    expect(typeof result.content[0].text).toBe('string');
  });
});
