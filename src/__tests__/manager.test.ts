import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VariantManager, type VariantState } from '../manager.js';

const bundlerControls = vi.hoisted(() => ({
  outcomes: new Map<string, 'connected' | 'disconnected'>(),
  instances: [] as Array<{
    name: string;
    state: string;
    reconnectNowCalls: number;
    closeCalls: number;
    reconnectEnabled: boolean;
  }>,
  adapterInstances: [] as Array<{
    toolRegistrations: number;
    toolUnregistrations: number;
    resourceRegistrations: number;
    resourceUnregistrations: number;
    promptRegistrations: number;
    promptUnregistrations: number;
    mapResource?: (resource: {
      name: string;
      uri: string;
      title?: string;
      description?: string;
      mimeType?: string;
    }) => {
      name: string;
      uri: string;
      title?: string;
      description?: string;
      mimeType?: string;
    };
  }>,
}));

vi.mock('@kunobi/mcp-bundler', () => {
  class MockBundler {
    name: string;
    state = 'idle';
    reconnectNowCalls = 0;
    closeCalls = 0;
    reconnectEnabled: boolean;
    handlers = new Map<string, Array<() => void | Promise<void>>>();
    toolDefinitions = [
      {
        name: 'k8s',
        description: 'Kubernetes operations',
        inputSchema: {
          type: 'object',
          properties: { action: { type: 'string' } },
          required: ['action'],
        },
      },
    ];
    resourceDefinitions = [
      {
        uri: 'kunobi://resource/status',
        name: 'status',
        description: 'Status resource',
      },
    ];
    promptDefinitions = [
      {
        name: 'setup',
        description: 'Setup prompt',
        arguments: [{ name: 'cluster', required: false }],
      },
    ];

    constructor(options: {
      name: string;
      reconnect?: { enabled?: boolean };
    }) {
      this.name = options.name;
      this.reconnectEnabled = options.reconnect?.enabled ?? true;
      bundlerControls.instances.push(this);
    }

    on(event: string, handler: () => void | Promise<void>) {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event)?.push(handler);
    }

    emit(event: string) {
      for (const handler of this.handlers.get(event) ?? []) {
        void handler();
      }
    }

    async reconnectNow() {
      this.reconnectNowCalls++;
      const outcome = bundlerControls.outcomes.get(this.name) ?? 'connected';
      this.state = outcome;
      if (outcome === 'connected') {
        this.emit('connected');
      }
    }

    async close() {
      this.closeCalls++;
      this.state = 'idle';
    }

    getState() {
      return this.state;
    }

    getTools() {
      return this.toolDefinitions.map((tool) => tool.name);
    }

    getToolDefinitions() {
      return this.toolDefinitions;
    }

    getResourceDefinitions() {
      return this.resourceDefinitions;
    }

    getPromptDefinitions() {
      return this.promptDefinitions;
    }

    async callTool(name: string, args: Record<string, unknown>) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `${name}:${JSON.stringify(args)}`,
          },
        ],
      };
    }
  }

  class MockBundlerServerAdapter {
    toolRegistrations = 0;
    toolUnregistrations = 0;
    resourceRegistrations = 0;
    resourceUnregistrations = 0;
    promptRegistrations = 0;
    promptUnregistrations = 0;
    mapResource?: (resource: {
      name: string;
      uri: string;
      title?: string;
      description?: string;
      mimeType?: string;
    }) => {
      name: string;
      uri: string;
      title?: string;
      description?: string;
      mimeType?: string;
    };

    constructor(
      _bundler: MockBundler,
      options?: {
        mapResource?: MockBundlerServerAdapter['mapResource'];
      },
    ) {
      this.mapResource = options?.mapResource;
      bundlerControls.adapterInstances.push(this);
    }

    async registerTools() {
      this.toolRegistrations++;
    }

    unregisterTools() {
      this.toolUnregistrations++;
    }

    async registerResources() {
      this.resourceRegistrations++;
    }

    unregisterResources() {
      this.resourceUnregistrations++;
    }

    async registerPrompts() {
      this.promptRegistrations++;
    }

    unregisterPrompts() {
      this.promptUnregistrations++;
    }
  }

  return {
    McpBundler: MockBundler,
    McpBundlerServerAdapter: MockBundlerServerAdapter,
  };
});

function createServer(): McpServer {
  return new McpServer(
    { name: 'test', version: '0.0.1' },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
        logging: {},
      },
    },
  );
}

describe('VariantManager', () => {
  afterEach(() => {
    bundlerControls.outcomes.clear();
    bundlerControls.instances.length = 0;
    bundlerControls.adapterInstances.length = 0;
    vi.restoreAllMocks();
  });

  it('can be constructed with options', () => {
    const server = createServer();
    const manager = new VariantManager(server, {
      ports: { dev: 3400 },
      reconnectIntervalMs: 5000,
    });
    expect(manager).toBeDefined();
  });

  it('getStates returns all configured variants as not_running initially', () => {
    const server = createServer();
    const manager = new VariantManager(server, {
      ports: { dev: 3400, e2e: 3600 },
      reconnectIntervalMs: 5000,
    });

    const states = manager.getStates();
    expect(states.get('dev')).toMatchObject({
      port: 3400,
      status: 'not_running',
    });
    expect(states.get('e2e')).toMatchObject({
      port: 3600,
      status: 'not_running',
    });
  });

  it('exposes lastRefreshTime after a refresh', async () => {
    bundlerControls.outcomes.set('dev', 'connected');

    const server = createServer();
    const manager = new VariantManager(server, {
      ports: { dev: 3400 },
      reconnectIntervalMs: 5000,
    });

    expect(manager.getLastRefreshTime()).toBeNull();
    await manager.refresh();
    expect(manager.getLastRefreshTime()).toBeInstanceOf(Date);
  });

  it('stop resolves even if never started', async () => {
    const server = createServer();
    const manager = new VariantManager(server, {
      ports: { dev: 3400 },
      reconnectIntervalMs: 5000,
    });
    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it('passes through autoReconnect=false for manual-only mode', async () => {
    bundlerControls.outcomes.set('dev', 'disconnected');

    const server = createServer();
    const manager = new VariantManager(server, {
      ports: { dev: 3400 },
      reconnectIntervalMs: 5000,
      autoReconnect: false,
    });

    await manager.refresh();

    expect(bundlerControls.instances[0]?.reconnectEnabled).toBe(false);
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

  it('has expected shape for not_running variant', () => {
    const state: VariantState = {
      port: 3400,
      status: 'not_running',
      tools: [],
    };
    expect(state.status).toBe('not_running');
  });
});

describe('persistent bundler lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    bundlerControls.outcomes.clear();
    bundlerControls.instances.length = 0;
    bundlerControls.adapterInstances.length = 0;
    vi.restoreAllMocks();
  });

  it('tracks a configured variant and exposes its catalog after a successful refresh', async () => {
    bundlerControls.outcomes.set('dev', 'connected');

    const server = createServer();
    const manager = new VariantManager(server, {
      ports: { dev: 3400 },
      reconnectIntervalMs: 5000,
    });

    await manager.refresh();

    const state = manager.getStates().get('dev');
    expect(state?.status).toBe('connected');

    const catalog = manager.getCatalog().get('dev');
    expect(catalog?.status).toBe('connected');
    expect(catalog?.tools[0]?.name).toBe('k8s');
    expect(catalog?.resources[0]?.uri).toBe('kunobi://resource/status');
    expect(catalog?.prompts[0]?.name).toBe('setup');
  });

  it('namespaces proxied resource URIs per variant through the adapter', async () => {
    bundlerControls.outcomes.set('dev', 'connected');

    const server = createServer();
    const manager = new VariantManager(server, {
      ports: { dev: 3400 },
      reconnectIntervalMs: 5000,
    });

    await manager.refresh();

    const mapped = bundlerControls.adapterInstances[0]?.mapResource?.({
      name: 'status',
      uri: 'kunobi://resource/status',
      description: 'Status resource',
    });

    expect(mapped?.name).toBe('dev__status');
    expect(mapped?.uri).toBe(
      'kunobi://variant/dev/resource/kunobi%3A%2F%2Fresource%2Fstatus',
    );
  });

  it('keeps a variant tracked as disconnected when the connection attempt fails', async () => {
    bundlerControls.outcomes.set('dev', 'disconnected');

    const server = createServer();
    const manager = new VariantManager(server, {
      ports: { dev: 3400 },
      reconnectIntervalMs: 5000,
    });

    await manager.refresh();

    expect(manager.getStates().get('dev')?.status).toBe('disconnected');
  });

  it('refresh retries tracked disconnected variants through reconnectNow', async () => {
    bundlerControls.outcomes.set('dev', 'disconnected');

    const server = createServer();
    const manager = new VariantManager(server, {
      ports: { dev: 3400 },
      reconnectIntervalMs: 5000,
    });

    await manager.refresh();
    expect(bundlerControls.instances[0]?.reconnectNowCalls).toBe(1);
    expect(manager.getStates().get('dev')?.status).toBe('disconnected');

    bundlerControls.outcomes.set('dev', 'connected');
    await manager.refresh();

    expect(bundlerControls.instances[0]?.reconnectNowCalls).toBe(2);
    expect(manager.getStates().get('dev')?.status).toBe('connected');
  });

  it('start triggers the initial refresh pass', () => {
    const server = createServer();
    const manager = new VariantManager(server, {
      ports: { dev: 3400 },
      reconnectIntervalMs: 5000,
    });

    const refreshSpy = vi
      .spyOn(manager, 'refresh')
      .mockResolvedValue(undefined);
    manager.start();

    expect(refreshSpy).toHaveBeenCalledOnce();
  });

  it('stop closes tracked bundlers and clears visible state', async () => {
    bundlerControls.outcomes.set('dev', 'connected');

    const server = createServer();
    const manager = new VariantManager(server, {
      ports: { dev: 3400 },
      reconnectIntervalMs: 5000,
    });

    await manager.refresh();
    expect(manager.getStates().get('dev')?.status).toBe('connected');

    await manager.stop();

    expect(bundlerControls.instances[0]?.closeCalls).toBe(1);
    expect(manager.getStates().get('dev')?.status).toBe('not_running');
  });

  it('callVariantTool delegates to the tracked bundler', async () => {
    bundlerControls.outcomes.set('dev', 'connected');

    const server = createServer();
    const manager = new VariantManager(server, {
      ports: { dev: 3400 },
      reconnectIntervalMs: 5000,
    });

    await manager.refresh();

    const result = await manager.callVariantTool('dev', 'k8s', {
      action: 'list',
    });
    expect(result?.content[0]?.text).toBe('k8s:{"action":"list"}');
  });

  it('delegates calls even when the variant is currently disconnected', async () => {
    bundlerControls.outcomes.set('dev', 'disconnected');

    const server = createServer();
    const manager = new VariantManager(server, {
      ports: { dev: 3400 },
      reconnectIntervalMs: 5000,
    });

    await manager.refresh();

    const result = await manager.callVariantTool('dev', 'k8s', {
      action: 'list',
    });
    expect(result?.content[0]?.text).toBe('k8s:{"action":"list"}');
  });

  it('still returns null for unknown variants', async () => {
    const server = createServer();
    const manager = new VariantManager(server, {
      ports: { dev: 3400 },
      reconnectIntervalMs: 5000,
    });

    const result = await manager.callVariantTool('unknown', 'k8s');
    expect(result).toBeNull();
  });

  it('keeps registrations intact during the disconnect grace window', async () => {
    bundlerControls.outcomes.set('dev', 'connected');

    const server = createServer();
    const manager = new VariantManager(server, {
      ports: { dev: 3400 },
      reconnectIntervalMs: 5000,
    });

    await manager.refresh();

    const bundler = bundlerControls.instances[0] as unknown as {
      state: string;
      emit: (event: string) => void;
    };
    const adapter = bundlerControls.adapterInstances[0];

    const initialToolUnregistrations = adapter?.toolUnregistrations ?? 0;
    const initialResourceUnregistrations =
      adapter?.resourceUnregistrations ?? 0;
    const initialPromptUnregistrations = adapter?.promptUnregistrations ?? 0;

    bundler.state = 'disconnected';
    bundler.emit('disconnected');

    expect(adapter?.toolUnregistrations).toBe(initialToolUnregistrations);
    expect(adapter?.resourceUnregistrations).toBe(
      initialResourceUnregistrations,
    );
    expect(adapter?.promptUnregistrations).toBe(initialPromptUnregistrations);

    await vi.advanceTimersByTimeAsync(9900);
    expect(adapter?.toolUnregistrations).toBe(initialToolUnregistrations);

    await vi.advanceTimersByTimeAsync(200);
    expect(adapter?.toolUnregistrations).toBe(initialToolUnregistrations + 1);
    expect(adapter?.resourceUnregistrations).toBe(
      initialResourceUnregistrations + 1,
    );
    expect(adapter?.promptUnregistrations).toBe(
      initialPromptUnregistrations + 1,
    );
  });

  it('re-syncs registrations and cancels pending disconnect cleanup when the variant reconnects quickly', async () => {
    bundlerControls.outcomes.set('dev', 'connected');

    const server = createServer();
    const manager = new VariantManager(server, {
      ports: { dev: 3400 },
      reconnectIntervalMs: 5000,
    });

    await manager.refresh();

    const bundler = bundlerControls.instances[0] as unknown as {
      state: string;
      emit: (event: string) => void;
    };
    const adapter = bundlerControls.adapterInstances[0];

    const initialToolRegistrations = adapter?.toolRegistrations ?? 0;
    const initialResourceRegistrations = adapter?.resourceRegistrations ?? 0;
    const initialPromptRegistrations = adapter?.promptRegistrations ?? 0;
    const initialToolUnregistrations = adapter?.toolUnregistrations ?? 0;
    const initialResourceUnregistrations =
      adapter?.resourceUnregistrations ?? 0;
    const initialPromptUnregistrations = adapter?.promptUnregistrations ?? 0;

    bundler.state = 'disconnected';
    bundler.emit('disconnected');
    await vi.advanceTimersByTimeAsync(5000);

    bundler.state = 'connected';
    bundler.emit('connected');
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter?.toolRegistrations).toBe(initialToolRegistrations + 1);
    expect(adapter?.resourceRegistrations).toBe(
      initialResourceRegistrations + 1,
    );
    expect(adapter?.promptRegistrations).toBe(initialPromptRegistrations + 1);
    expect(adapter?.toolUnregistrations).toBe(initialToolUnregistrations + 1);
    expect(adapter?.resourceUnregistrations).toBe(
      initialResourceUnregistrations + 1,
    );
    expect(adapter?.promptUnregistrations).toBe(
      initialPromptUnregistrations + 1,
    );

    await vi.advanceTimersByTimeAsync(6000);
    expect(adapter?.toolUnregistrations).toBe(initialToolUnregistrations + 1);
    expect(adapter?.resourceUnregistrations).toBe(
      initialResourceUnregistrations + 1,
    );
    expect(adapter?.promptUnregistrations).toBe(
      initialPromptUnregistrations + 1,
    );
  });

  it('updates status resources immediately without flapping list notifications on transient disconnects', async () => {
    bundlerControls.outcomes.set('dev', 'connected');

    const server = createServer();
    const sendToolListChanged = vi
      .spyOn(server.server, 'sendToolListChanged')
      .mockResolvedValue(undefined);
    const sendResourceListChanged = vi
      .spyOn(server.server, 'sendResourceListChanged')
      .mockResolvedValue(undefined);
    const sendPromptListChanged = vi
      .spyOn(server.server, 'sendPromptListChanged')
      .mockResolvedValue(undefined);
    const sendResourceUpdated = vi
      .spyOn(server.server, 'sendResourceUpdated')
      .mockResolvedValue(undefined);

    const manager = new VariantManager(server, {
      ports: { dev: 3400 },
      reconnectIntervalMs: 5000,
    });

    await manager.refresh();
    await vi.advanceTimersByTimeAsync(150);
    sendToolListChanged.mockClear();
    sendResourceListChanged.mockClear();
    sendPromptListChanged.mockClear();
    sendResourceUpdated.mockClear();

    const bundler = bundlerControls.instances[0] as unknown as {
      state: string;
      emit: (event: string) => void;
    };
    bundler.state = 'disconnected';
    bundler.emit('disconnected');

    await vi.advanceTimersByTimeAsync(150);

    expect(sendToolListChanged).not.toHaveBeenCalled();
    expect(sendResourceListChanged).not.toHaveBeenCalled();
    expect(sendPromptListChanged).not.toHaveBeenCalled();
    expect(sendResourceUpdated).toHaveBeenCalledWith({
      uri: 'kunobi://status',
    });
    expect(sendResourceUpdated).toHaveBeenCalledWith({
      uri: 'kunobi://tools',
    });
  });

  it('notifies tools, resources, prompts, and status updates after a variant connects', async () => {
    bundlerControls.outcomes.set('dev', 'connected');

    const server = createServer();
    const sendToolListChanged = vi
      .spyOn(server.server, 'sendToolListChanged')
      .mockResolvedValue(undefined);
    const sendResourceListChanged = vi
      .spyOn(server.server, 'sendResourceListChanged')
      .mockResolvedValue(undefined);
    const sendPromptListChanged = vi
      .spyOn(server.server, 'sendPromptListChanged')
      .mockResolvedValue(undefined);
    const sendResourceUpdated = vi
      .spyOn(server.server, 'sendResourceUpdated')
      .mockResolvedValue(undefined);

    const manager = new VariantManager(server, {
      ports: { dev: 3400 },
      reconnectIntervalMs: 5000,
    });

    await manager.refresh();
    await vi.advanceTimersByTimeAsync(150);

    expect(sendToolListChanged).toHaveBeenCalled();
    expect(sendResourceListChanged).toHaveBeenCalled();
    expect(sendPromptListChanged).toHaveBeenCalled();
    expect(sendResourceUpdated).toHaveBeenCalledWith({
      uri: 'kunobi://status',
    });
    expect(sendResourceUpdated).toHaveBeenCalledWith({
      uri: 'kunobi://tools',
    });
  });
});
