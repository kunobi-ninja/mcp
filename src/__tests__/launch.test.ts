import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { registerLaunchTool } from '../tools/launch.js';

vi.mock('../discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../discovery.js')>();
  return {
    ...actual,
    findKunobiVariants: vi.fn().mockReturnValue([]),
    getLaunchCommand: vi.fn().mockReturnValue(null),
  };
});

vi.mock('node:child_process', () => ({
  spawn: vi.fn().mockReturnValue({ unref: vi.fn() }),
}));

import { spawn } from 'node:child_process';
import { findKunobiVariants, getLaunchCommand } from '../discovery.js';

type ServerInternals = {
  _registeredTools: Record<
    string,
    {
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        openWorldHint?: boolean;
      };
      handler: (args: Record<string, unknown>) => Promise<{
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
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

function getHandler(server: McpServer) {
  return (server as unknown as ServerInternals)._registeredTools.kunobi_launch
    .handler;
}

describe('registerLaunchTool', () => {
  it('registers kunobi_launch tool', () => {
    const server = createServer();
    registerLaunchTool(server);
    const tool = (server as unknown as ServerInternals)._registeredTools
      .kunobi_launch;
    expect(tool).toBeDefined();
    expect(tool.annotations?.readOnlyHint).toBe(false);
  });

  it('returns error when no variants are installed', async () => {
    vi.mocked(findKunobiVariants).mockReturnValue([]);
    const server = createServer();
    registerLaunchTool(server);

    const result = await getHandler(server)({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not installed');
    expect(result.content[0].text).toContain('kunobi.ninja');
  });

  it('returns error when specified variant is not installed', async () => {
    vi.mocked(findKunobiVariants).mockReturnValue(['Kunobi', 'Kunobi Dev']);
    const server = createServer();
    registerLaunchTool(server);

    const result = await getHandler(server)({ variant: 'Kunobi E2E' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not installed');
    expect(result.content[0].text).toContain('Kunobi, Kunobi Dev');
  });

  it('returns error when platform has no launch command', async () => {
    vi.mocked(findKunobiVariants).mockReturnValue(['Kunobi']);
    vi.mocked(getLaunchCommand).mockReturnValue(null);
    const server = createServer();
    registerLaunchTool(server);

    const result = await getHandler(server)({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Could not determine');
  });

  it('spawns process and returns success on valid variant', async () => {
    vi.mocked(findKunobiVariants).mockReturnValue(['Kunobi']);
    vi.mocked(getLaunchCommand).mockReturnValue({
      command: 'open',
      args: ['-a', 'Kunobi'],
    });
    const server = createServer();
    registerLaunchTool(server);

    const result = await getHandler(server)({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Launching Kunobi');
    expect(spawn).toHaveBeenCalledWith('open', ['-a', 'Kunobi'], {
      detached: true,
      stdio: 'ignore',
    });
  });

  it('uses first installed variant when none specified', async () => {
    vi.mocked(findKunobiVariants).mockReturnValue(['Kunobi Dev', 'Kunobi']);
    vi.mocked(getLaunchCommand).mockReturnValue({
      command: 'open',
      args: ['-a', 'Kunobi Dev'],
    });
    const server = createServer();
    registerLaunchTool(server);

    const result = await getHandler(server)({});
    expect(result.content[0].text).toContain('Kunobi Dev');
  });
});
