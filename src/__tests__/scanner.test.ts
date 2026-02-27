import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VariantScanner, type VariantState } from '../scanner.js';

vi.mock('../discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../discovery.js')>();
  return { ...actual, probeKunobiServer: vi.fn().mockResolvedValue(null) };
});

function createServer(): McpServer {
  return new McpServer(
    { name: 'test', version: '0.0.1' },
    { capabilities: { tools: { listChanged: true }, logging: {} } },
  );
}

describe('VariantScanner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('can be constructed with options', () => {
    const server = createServer();
    const scanner = new VariantScanner(server, {
      ports: { dev: 3400 },
      intervalMs: 5000,
      missThreshold: 3,
    });
    expect(scanner).toBeDefined();
  });

  it('getStates returns all configured variants as not_detected initially', () => {
    const server = createServer();
    const scanner = new VariantScanner(server, {
      ports: { dev: 3400, e2e: 3600 },
      intervalMs: 5000,
      missThreshold: 3,
    });

    const states = scanner.getStates();
    expect(states.get('dev')).toMatchObject({
      port: 3400,
      status: 'not_detected',
    });
    expect(states.get('e2e')).toMatchObject({
      port: 3600,
      status: 'not_detected',
    });
  });

  it('exposes lastScanTime after a scan', async () => {
    const { probeKunobiServer } = await import('../discovery.js');
    vi.mocked(probeKunobiServer).mockResolvedValue(null);

    const server = createServer();
    const scanner = new VariantScanner(server, {
      ports: { dev: 3400 },
      intervalMs: 5000,
      missThreshold: 3,
    });
    expect(scanner.getLastScanTime()).toBeNull();
    await scanner.scan();
    expect(scanner.getLastScanTime()).toBeInstanceOf(Date);
  });

  it('stop resolves even if never started', async () => {
    const server = createServer();
    const scanner = new VariantScanner(server, {
      ports: { dev: 3400 },
      intervalMs: 5000,
      missThreshold: 3,
    });
    await expect(scanner.stop()).resolves.toBeUndefined();
  });
});

describe('VariantState type', () => {
  it('has expected shape for connected variant', () => {
    const state: VariantState = {
      port: 3400,
      status: 'connected',
      tools: ['dev/foo', 'dev/bar'],
    };
    expect(state.status).toBe('connected');
    expect(state.tools).toHaveLength(2);
  });

  it('has expected shape for not_detected variant', () => {
    const state: VariantState = {
      port: 3400,
      status: 'not_detected',
      tools: [],
    };
    expect(state.status).toBe('not_detected');
  });
});
