import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import type { VariantManager, VariantState } from '../manager.js';
import type { ProxyCaller, ProxyCallerEntry } from '../tools/call.js';
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
    callVariantTool,
  } as unknown as VariantManager;
}

function fakeUpstream(
  variant: string,
  uuid: string,
): ProxyCallerEntry & { variant: string; uuid: string } {
  return {
    variant,
    uuid,
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text' as const, text: `ok:${variant}:${uuid}` }],
    }),
  };
}

function fakeRegistry(
  entries: Array<ProxyCallerEntry & { variant: string; uuid: string }>,
): ProxyCaller {
  return {
    get: (variant, uuid) =>
      entries.find((e) => e.variant === variant && e.uuid === uuid),
    snapshot: () => entries.map((e) => ({ variant: e.variant, uuid: e.uuid })),
  };
}

async function getHandler(
  server: McpServer,
): Promise<RegisteredTool['handler']> {
  const tool = (server as unknown as ServerInternals)._registeredTools
    .kunobi_call;
  if (!tool) throw new Error('kunobi_call should be registered');
  return tool.handler;
}

describe('registerCallTool — proxy_uuid addressing', () => {
  it('routes kunobi_call with proxy_uuid to the (variant,uuid) upstream using the original tool name', async () => {
    const server = createServer();
    const entry = fakeUpstream('dev', 'u1');
    const registry = fakeRegistry([entry]);
    const manager = mockManager({});
    registerCallTool(server, manager, registry);
    const handler = await getHandler(server);

    const result = await handler({
      variant: 'dev',
      tool: 'signoz_query_range',
      proxy_uuid: 'u1',
      arguments: {},
    });

    expect(entry.callTool).toHaveBeenCalledWith('signoz_query_range', {});
    expect(result.isError).toBeFalsy();
  });

  it('same proxy_uuid under two variants routes by variant, not uuid alone', async () => {
    const server = createServer();
    const dev = fakeUpstream('dev', 'shared');
    const uns = fakeUpstream('unstable', 'shared');
    const registry = fakeRegistry([dev, uns]);
    const manager = mockManager({});
    registerCallTool(server, manager, registry);
    const handler = await getHandler(server);

    await handler({
      variant: 'unstable',
      tool: 't',
      proxy_uuid: 'shared',
      arguments: {},
    });

    expect(uns.callTool).toHaveBeenCalled();
    expect(dev.callTool).not.toHaveBeenCalled();
  });

  it('returns isError naming available addresses when the (variant,proxy_uuid) is unknown', async () => {
    const server = createServer();
    const entry = fakeUpstream('dev', 'u1');
    const registry = fakeRegistry([entry]);
    const manager = mockManager({});
    registerCallTool(server, manager, registry);
    const handler = await getHandler(server);

    const result = await handler({
      variant: 'dev',
      tool: 't',
      proxy_uuid: 'does-not-exist',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('dev');
    expect(result.content[0]?.text).toContain('u1');
  });

  it('kunobi_call without proxy_uuid keeps existing variant behavior', async () => {
    const server = createServer();
    const callVariantTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text' as const, text: 'forwarded:list' }],
    });
    const manager = mockManager(
      { dev: { port: 3400, status: 'connected', tools: ['dev__k8s'] } },
      callVariantTool,
    );
    const registry = fakeRegistry([]);
    registerCallTool(server, manager, registry);
    const handler = await getHandler(server);

    const result = await handler({
      variant: 'dev',
      tool: 'k8s',
      arguments: { action: 'list' },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe('forwarded:list');
    expect(callVariantTool).toHaveBeenCalledWith('dev', 'k8s', {
      action: 'list',
    });
  });
});
