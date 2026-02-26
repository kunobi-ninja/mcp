import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VariantScanner, type VariantState } from '../scanner.js';

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
