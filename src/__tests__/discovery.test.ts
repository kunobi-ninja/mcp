import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the config module so getConnectionConfig always starts from known defaults
// regardless of what's in the real ~/.config/kunobi/mcp.json
vi.mock('../config.js', () => ({
  CONFIG_DEFAULTS: {
    variants: {
      legacy: 3030,
      stable: 3200,
      unstable: 3300,
      dev: 3400,
      local: 3500,
      e2e: 3600,
    },
  },
  DEFAULT_CONFIG_PATH: '/tmp/test-kunobi/mcp.json',
  loadConfig: () => ({
    variants: {
      legacy: 3030,
      stable: 3200,
      unstable: 3300,
      dev: 3400,
      local: 3500,
      e2e: 3600,
    },
  }),
  saveConfig: () => {},
}));

import {
  DEFAULT_VARIANT_PORTS,
  getConnectionConfig,
  inspectKunobiServer,
  launchHint,
  parseJsonOrSse,
} from '../discovery.js';

describe('DEFAULT_VARIANT_PORTS', () => {
  it('contains all known variants', () => {
    expect(DEFAULT_VARIANT_PORTS).toEqual({
      legacy: 3030,
      stable: 3200,
      unstable: 3300,
      dev: 3400,
      local: 3500,
      e2e: 3600,
    });
  });
});

describe('getConnectionConfig', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [
      'MCP_KUNOBI_RECONNECT_INTERVAL_MS',
      'MCP_KUNOBI_VARIANTS',
      'MCP_KUNOBI_AUTO_CONNECT',
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('returns defaults when no env vars are set', () => {
    const config = getConnectionConfig();
    expect(config.ports).toEqual(DEFAULT_VARIANT_PORTS);
    expect(config.reconnectIntervalMs).toBe(5000);
    expect(config.autoConnect).toBe(true);
  });

  it('respects MCP_KUNOBI_RECONNECT_INTERVAL_MS', () => {
    process.env.MCP_KUNOBI_RECONNECT_INTERVAL_MS = '10000';
    expect(getConnectionConfig().reconnectIntervalMs).toBe(10000);
  });

  it('respects MCP_KUNOBI_AUTO_CONNECT=false', () => {
    process.env.MCP_KUNOBI_AUTO_CONNECT = 'false';
    expect(getConnectionConfig().autoConnect).toBe(false);
  });

  it('parses name:port format in MCP_KUNOBI_VARIANTS', () => {
    process.env.MCP_KUNOBI_VARIANTS = 'juan:4200,test:5000';
    const config = getConnectionConfig();
    expect(config.ports.juan).toBe(4200);
    expect(config.ports.test).toBe(5000);
    // defaults still present
    expect(config.ports.stable).toBe(3200);
  });

  it('name:port entries override same-named defaults', () => {
    process.env.MCP_KUNOBI_VARIANTS = 'dev:9999';
    const config = getConnectionConfig();
    expect(config.ports.dev).toBe(9999);
    // other defaults still present
    expect(config.ports.stable).toBe(3200);
  });
});

describe('parseJsonOrSse', () => {
  it('parses plain JSON response', async () => {
    const body = JSON.stringify({ result: { value: 42 } });
    const response = new Response(body);
    const parsed = await parseJsonOrSse<{ result: { value: number } }>(
      response,
    );
    expect(parsed).toEqual({ result: { value: 42 } });
  });

  it('parses SSE-formatted response (data: prefix)', async () => {
    const json = { result: { serverInfo: { name: 'kunobi-mcp' } } };
    const body = `data: ${JSON.stringify(json)}\n\n`;
    const response = new Response(body);
    const parsed = await parseJsonOrSse<{
      result: { serverInfo: { name: string } };
    }>(response);
    expect(parsed).toEqual(json);
  });

  it('handles SSE with trailing newlines', async () => {
    const json = { result: 'ok' };
    const body = `data: ${JSON.stringify(json)}\n\ndata: [DONE]\n\n`;
    const response = new Response(body);
    const parsed = await parseJsonOrSse<{ result: string }>(response);
    expect(parsed).toEqual(json);
  });

  it('handles response with only whitespace around JSON', async () => {
    const body = '  \n  {"result": "ok"}  \n  ';
    const response = new Response(body);
    const parsed = await parseJsonOrSse<{ result: string }>(response);
    expect(parsed).toEqual({ result: 'ok' });
  });

  it('throws on completely empty response', async () => {
    const response = new Response('');
    await expect(parseJsonOrSse(response)).rejects.toThrow();
  });

  it('throws on malformed JSON', async () => {
    const response = new Response('{invalid json}');
    await expect(parseJsonOrSse(response)).rejects.toThrow();
  });

  it('throws on malformed SSE payload', async () => {
    const response = new Response('data: {invalid json}\n\n');
    await expect(parseJsonOrSse(response)).rejects.toThrow();
  });
});

describe('inspectKunobiServer', () => {
  it('returns null for unreachable port', async () => {
    const result = await inspectKunobiServer('http://127.0.0.1:19999/mcp');
    expect(result).toBeNull();
  });

  it('returns null for non-kunobi server', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          result: { serverInfo: { name: 'some-other-server' } },
        }),
        { status: 200 },
      ),
    );

    const result = await inspectKunobiServer('http://127.0.0.1:3400/mcp');
    expect(result).toBeNull();
    globalThis.fetch = originalFetch;
  });

  it('returns tools for a valid kunobi server', async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            result: { serverInfo: { name: 'kunobi-dev' } },
          }),
          { status: 200, headers: { 'mcp-session-id': 'sess-123' } },
        );
      }
      if (callCount === 2) {
        return new Response('', { status: 200 });
      }
      return new Response(
        JSON.stringify({
          result: { tools: [{ name: 'app_info' }, { name: 'query_store' }] },
        }),
        { status: 200 },
      );
    });

    const result = await inspectKunobiServer('http://127.0.0.1:3400/mcp');
    expect(result).not.toBeNull();
    expect(result?.serverName).toBe('kunobi-dev');
    expect(result?.tools).toEqual(['app_info', 'query_store']);
    globalThis.fetch = originalFetch;
  });

  it('returns empty tools if tools/list fails', async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            result: { serverInfo: { name: 'kunobi-stable' } },
          }),
          { status: 200 },
        );
      }
      if (callCount === 2) {
        return new Response('', { status: 200 });
      }
      return new Response('error', { status: 500 });
    });

    const result = await inspectKunobiServer('http://127.0.0.1:3200/mcp');
    expect(result).not.toBeNull();
    expect(result?.tools).toEqual([]);
    globalThis.fetch = originalFetch;
  });

  it('returns null when initialize response is not ok', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('error', { status: 500 }));

    const result = await inspectKunobiServer('http://127.0.0.1:3400/mcp');
    expect(result).toBeNull();
    globalThis.fetch = originalFetch;
  });

  it('handles missing serverInfo gracefully', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ result: {} }), { status: 200 }),
      );

    const result = await inspectKunobiServer('http://127.0.0.1:3400/mcp');
    expect(result).toBeNull();
    globalThis.fetch = originalFetch;
  });
});

describe('launchHint', () => {
  it('returns a non-empty string', () => {
    const hint = launchHint();
    expect(typeof hint).toBe('string');
    expect(hint.length).toBeGreaterThan(0);
  });

  it('mentions launch/app/Applications/Start menu', () => {
    const hint = launchHint();
    expect(hint).toMatch(/Applications|app launcher|terminal|Start menu/i);
  });
});
