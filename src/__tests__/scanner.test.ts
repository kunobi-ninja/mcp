import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VariantScanner, type VariantState } from '../scanner.js';

vi.mock('../discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../discovery.js')>();
  return { ...actual, probeKunobiServer: vi.fn().mockResolvedValue(null) };
});

vi.mock('@kunobi/mcp-bundler', () => {
  class MockBundler {
    tools: string[] = [];
    state = 'idle';
    handlers = new Map<string, (() => void)[]>();

    constructor() {}
    on(event: string, handler: () => void) {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event)?.push(handler);
    }
    emit(event: string) {
      for (const h of this.handlers.get(event) ?? []) h();
    }
    async connect() {
      this.state = 'connected';
    }
    async close() {
      this.state = 'idle';
    }
    getState() {
      return this.state;
    }
    getTools() {
      return this.tools;
    }
    registerTools() {}
    unregisterTools() {}
  }
  return { McpBundler: MockBundler };
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
      tools: ['dev__foo', 'dev__bar'],
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

describe('scan lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('detects a new variant when probe succeeds', async () => {
    const { probeKunobiServer } = await import('../discovery.js');
    vi.mocked(probeKunobiServer).mockResolvedValue({
      tools: ['app_info'],
      serverName: 'kunobi-dev',
    });

    const server = createServer();
    const scanner = new VariantScanner(server, {
      ports: { dev: 3400 },
      intervalMs: 5000,
      missThreshold: 3,
    });

    await scanner.scan();

    const states = scanner.getStates();
    const devState = states.get('dev');
    // Variant was detected and tracked (bundler created)
    expect(devState).toBeDefined();
    expect(devState?.status).not.toBe('not_detected');
  });

  it('removes variant after reaching miss threshold', async () => {
    const { probeKunobiServer } = await import('../discovery.js');

    // First scan: variant detected
    vi.mocked(probeKunobiServer).mockResolvedValue({
      tools: ['app_info'],
      serverName: 'kunobi-dev',
    });

    const server = createServer();
    const scanner = new VariantScanner(server, {
      ports: { dev: 3400 },
      intervalMs: 5000,
      missThreshold: 2,
    });

    await scanner.scan();

    // Now variant disappears
    vi.mocked(probeKunobiServer).mockResolvedValue(null);

    // Miss 1
    await scanner.scan();
    let states = scanner.getStates();
    // Still tracked after 1 miss (threshold is 2)
    expect(states.get('dev')?.status).not.toBe('not_detected');

    // Miss 2 — reaches threshold, should be removed
    await scanner.scan();
    states = scanner.getStates();
    expect(states.get('dev')?.status).toBe('not_detected');
  });

  it('resets miss count on successful probe', async () => {
    const { probeKunobiServer } = await import('../discovery.js');

    vi.mocked(probeKunobiServer).mockResolvedValue({
      tools: [],
      serverName: 'kunobi-dev',
    });

    const server = createServer();
    const scanner = new VariantScanner(server, {
      ports: { dev: 3400 },
      intervalMs: 5000,
      missThreshold: 2,
    });

    // Initial detect
    await scanner.scan();

    // Miss 1
    vi.mocked(probeKunobiServer).mockResolvedValue(null);
    await scanner.scan();

    // Comes back before threshold
    vi.mocked(probeKunobiServer).mockResolvedValue({
      tools: [],
      serverName: 'kunobi-dev',
    });
    await scanner.scan();

    // Miss again — should be count 1, not 2
    vi.mocked(probeKunobiServer).mockResolvedValue(null);
    await scanner.scan();

    const states = scanner.getStates();
    // Still tracked (miss count reset, only 1 miss)
    expect(states.get('dev')?.status).not.toBe('not_detected');
  });

  it('prevents concurrent scans', async () => {
    const { probeKunobiServer } = await import('../discovery.js');
    let probeCount = 0;
    vi.mocked(probeKunobiServer).mockImplementation(async () => {
      probeCount++;
      // Simulate slow probe
      await new Promise((r) => setTimeout(r, 100));
      return null;
    });

    const server = createServer();
    const scanner = new VariantScanner(server, {
      ports: { dev: 3400, e2e: 3600 },
      intervalMs: 5000,
      missThreshold: 3,
    });

    // Start two scans simultaneously
    const scan1 = scanner.scan();
    const scan2 = scanner.scan();

    // Advance timers to let the slow probe resolve
    await vi.advanceTimersByTimeAsync(200);
    await scan1;
    await scan2;

    // Second scan was skipped due to scanning lock
    // Only one scan ran (probing 2 ports = 2 calls)
    expect(probeCount).toBe(2);
  });

  it('start creates interval and runs initial scan', async () => {
    const { probeKunobiServer } = await import('../discovery.js');
    vi.mocked(probeKunobiServer).mockResolvedValue(null);

    const server = createServer();
    const scanner = new VariantScanner(server, {
      ports: { dev: 3400 },
      intervalMs: 5000,
      missThreshold: 3,
    });

    scanner.start();
    // First scan runs immediately
    await vi.advanceTimersByTimeAsync(0);
    expect(scanner.getLastScanTime()).toBeInstanceOf(Date);

    await scanner.stop();
  });

  it('stop clears interval and cleans up tracked variants', async () => {
    const { probeKunobiServer } = await import('../discovery.js');
    vi.mocked(probeKunobiServer).mockResolvedValue({
      tools: ['t1'],
      serverName: 'kunobi-dev',
    });

    const server = createServer();
    const scanner = new VariantScanner(server, {
      ports: { dev: 3400 },
      intervalMs: 5000,
      missThreshold: 3,
    });

    await scanner.scan();
    // dev is now tracked
    expect(scanner.getStates().get('dev')?.status).not.toBe('not_detected');

    await scanner.stop();
    // After stop, tracked map is cleared
    expect(scanner.getStates().get('dev')?.status).toBe('not_detected');
  });
});
