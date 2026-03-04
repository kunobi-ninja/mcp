import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the config module so getScanConfig always starts from known defaults
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
  getScanConfig,
  launchHint,
  parseJsonOrSse,
  probeKunobiServer,
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

describe('getScanConfig', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [
      'MCP_KUNOBI_INTERVAL',
      'MCP_KUNOBI_PORTS',
      'MCP_KUNOBI_ENABLED',
      'MCP_KUNOBI_MISS_THRESHOLD',
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
    const config = getScanConfig();
    expect(config.ports).toEqual(DEFAULT_VARIANT_PORTS);
    expect(config.intervalMs).toBe(5000);
    expect(config.missThreshold).toBe(3);
    expect(config.enabled).toBe(true);
  });

  it('respects MCP_KUNOBI_INTERVAL', () => {
    process.env.MCP_KUNOBI_INTERVAL = '10000';
    expect(getScanConfig().intervalMs).toBe(10000);
  });

  it('respects MCP_KUNOBI_PORTS to filter variants', () => {
    process.env.MCP_KUNOBI_PORTS = '3400,3500';
    const config = getScanConfig();
    expect(config.ports).toEqual({ dev: 3400, local: 3500 });
  });

  it('respects MCP_KUNOBI_ENABLED=false', () => {
    process.env.MCP_KUNOBI_ENABLED = 'false';
    expect(getScanConfig().enabled).toBe(false);
  });

  it('respects MCP_KUNOBI_MISS_THRESHOLD', () => {
    process.env.MCP_KUNOBI_MISS_THRESHOLD = '5';
    expect(getScanConfig().missThreshold).toBe(5);
  });

  it('parses name:port format in MCP_KUNOBI_PORTS', () => {
    process.env.MCP_KUNOBI_PORTS = 'juan:4200,test:5000';
    const config = getScanConfig();
    expect(config.ports.juan).toBe(4200);
    expect(config.ports.test).toBe(5000);
    // defaults still present
    expect(config.ports.stable).toBe(3200);
  });

  it('name:port entries override same-named defaults', () => {
    process.env.MCP_KUNOBI_PORTS = 'dev:9999';
    const config = getScanConfig();
    expect(config.ports.dev).toBe(9999);
    // other defaults still present
    expect(config.ports.stable).toBe(3200);
  });

  it('bare numbers still filter (backward compat)', () => {
    process.env.MCP_KUNOBI_PORTS = '3400,3500';
    const config = getScanConfig();
    expect(config.ports).toEqual({ dev: 3400, local: 3500 });
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

describe('probeKunobiServer', () => {
  it('returns null for unreachable port', async () => {
    const result = await probeKunobiServer('http://127.0.0.1:19999/mcp');
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

    const result = await probeKunobiServer('http://127.0.0.1:3400/mcp');
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

    const result = await probeKunobiServer('http://127.0.0.1:3400/mcp');
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

    const result = await probeKunobiServer('http://127.0.0.1:3200/mcp');
    expect(result).not.toBeNull();
    expect(result?.tools).toEqual([]);
    globalThis.fetch = originalFetch;
  });

  it('returns null when initialize response is not ok', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('error', { status: 500 }));

    const result = await probeKunobiServer('http://127.0.0.1:3400/mcp');
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

    const result = await probeKunobiServer('http://127.0.0.1:3400/mcp');
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
