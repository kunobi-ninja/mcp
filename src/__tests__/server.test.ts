import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { detectKunobi, getMcpUrl, launchHint } from '../discovery.js';
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
  _registeredResources: Record<
    string,
    {
      name: string;
      metadata?: { description?: string; mimeType?: string };
      readCallback: (uri: URL) => Promise<{
        contents: Array<{ uri: string; mimeType?: string; text?: string }>;
      }>;
    }
  >;
  _registeredPrompts: Record<
    string,
    {
      description?: string;
      callback: () => Promise<{
        messages: Array<{
          role: string;
          content: { type: string; text: string };
        }>;
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

function getInternals(server: McpServer): ServerInternals {
  return server as unknown as ServerInternals;
}

describe('kunobi_status tool annotations', () => {
  it('has readOnlyHint set to true', () => {
    const server = createServer();
    registerStatusTool(server);

    const tool = getInternals(server)._registeredTools.kunobi_status;
    expect(tool.annotations).toBeDefined();
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.annotations?.destructiveHint).toBe(false);
    expect(tool.annotations?.openWorldHint).toBe(false);
  });
});

describe('kunobi://status resource', () => {
  it('registers and returns valid JSON content', async () => {
    const server = createServer();

    server.registerResource(
      'kunobi_status',
      'kunobi://status',
      {
        description: 'Current Kunobi connection state and available tools',
        mimeType: 'application/json',
      },
      async () => {
        const state = await detectKunobi();
        return {
          contents: [
            {
              uri: 'kunobi://status',
              mimeType: 'application/json',
              text: JSON.stringify(state, null, 2),
            },
          ],
        };
      },
    );

    const resource =
      getInternals(server)._registeredResources['kunobi://status'];
    expect(resource).toBeDefined();
    expect(resource.metadata?.mimeType).toBe('application/json');

    const result = await resource.readCallback(new URL('kunobi://status'));
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].uri).toBe('kunobi://status');

    const text = result.contents[0].text ?? '';
    const parsed = JSON.parse(text);
    expect(parsed).toHaveProperty('status');
  });
});

describe('kunobi-setup prompt', () => {
  it('registers and returns a message with setup instructions', async () => {
    const server = createServer();

    server.registerPrompt(
      'kunobi-setup',
      {
        description: 'Check Kunobi status and provide setup instructions',
      },
      async () => {
        const state = await detectKunobi();
        let instructions: string;

        switch (state.status) {
          case 'not_installed':
            instructions =
              'Kunobi is not installed. Download it from https://kunobi.ninja/downloads and install it on your system.';
            break;
          case 'installed_not_running':
            instructions = `Kunobi is installed but not running (found: ${state.variants.join(', ')}). ${launchHint()}`;
            break;
          case 'running_mcp_unreachable':
            instructions = `Kunobi is running (PID ${state.pid}) but the MCP endpoint is not reachable. Open Kunobi Settings and make sure MCP is enabled.`;
            break;
          case 'connected':
            instructions = `Kunobi is connected and ready. ${state.tools.length} tools available: ${state.tools.join(', ')}.${state.variants.length > 0 ? ` Installed variants: ${state.variants.join(', ')}.` : ''}`;
            break;
        }

        return {
          messages: [
            {
              role: 'user' as const,
              content: { type: 'text' as const, text: instructions },
            },
          ],
        };
      },
    );

    const prompt = getInternals(server)._registeredPrompts['kunobi-setup'];
    expect(prompt).toBeDefined();
    expect(prompt.description).toBe(
      'Check Kunobi status and provide setup instructions',
    );

    const result = await prompt.callback();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content.type).toBe('text');
    expect(typeof result.messages[0].content.text).toBe('string');
    expect(result.messages[0].content.text.length).toBeGreaterThan(0);
  });
});

describe('kunobi-doctor prompt', () => {
  it('registers and returns diagnostic steps', async () => {
    const server = createServer();

    server.registerPrompt(
      'kunobi-doctor',
      {
        description:
          'Diagnose why Kunobi tools are unavailable and suggest fixes',
      },
      async () => {
        const state = await detectKunobi();
        const steps: string[] = [];

        switch (state.status) {
          case 'not_installed':
            steps.push(
              'Kunobi is not installed on this system.',
              '1. Download Kunobi from https://kunobi.ninja/downloads',
              '2. Install and launch the application',
              '3. Enable MCP in Kunobi Settings',
            );
            break;
          case 'installed_not_running':
            steps.push(
              `Kunobi is installed but not running. Found variants: ${state.variants.join(', ')}.`,
              `1. ${launchHint()}`,
              '2. Wait a few seconds for MCP to initialize',
              '3. Tools will appear automatically once connected',
            );
            break;
          case 'running_mcp_unreachable':
            steps.push(
              `Kunobi is running (PID ${state.pid}) but the MCP endpoint is unreachable.`,
              '1. Open Kunobi Settings and verify MCP is enabled',
              `2. Check that the MCP endpoint is accessible at ${getMcpUrl()}`,
              '3. Try restarting Kunobi',
            );
            break;
          case 'connected':
            steps.push(
              'No issues detected — Kunobi is connected and working.',
              `${state.tools.length} tools available: ${state.tools.join(', ')}`,
            );
            break;
        }

        return {
          messages: [
            {
              role: 'user' as const,
              content: { type: 'text' as const, text: steps.join('\n') },
            },
          ],
        };
      },
    );

    const prompt = getInternals(server)._registeredPrompts['kunobi-doctor'];
    expect(prompt).toBeDefined();

    const result = await prompt.callback();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content.text).toContain('Kunobi');
  });
});
