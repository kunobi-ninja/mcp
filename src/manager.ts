import { McpBundler, McpBundlerServerAdapter } from '@kunobi/mcp-bundler';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  CallToolResult,
  Prompt,
  Resource,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

export interface VariantManagerOptions {
  ports: Record<string, number>;
  reconnectIntervalMs: number;
  autoReconnect?: boolean;
  logger?: (level: string, message: string, data?: unknown) => void;
}

export interface VariantState {
  port: number;
  status: 'connected' | 'connecting' | 'disconnected' | 'not_running';
  tools: string[];
}

export interface VariantCatalogEntry {
  port: number;
  status: VariantState['status'];
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
}

interface TrackedVariant {
  adapter: McpBundlerServerAdapter;
  bundler: McpBundler;
  port: number;
  disconnectCleanupTimer: ReturnType<typeof setTimeout> | null;
}

const DISCONNECT_GRACE_MULTIPLIER = 2;
const MIN_DISCONNECT_GRACE_MS = 1_000;
const MAX_DISCONNECT_GRACE_MS = 30_000;

function buildVariantResourceUri(variant: string, uri: string): string {
  return `kunobi://variant/${encodeURIComponent(variant)}/resource/${encodeURIComponent(uri)}`;
}

function buildVariantResourceName(variant: string, resource: Resource): string {
  return `${variant}__${resource.name}`;
}

export class VariantManager {
  private readonly server: McpServer;
  private readonly ports: Record<string, number>;
  private readonly reconnectIntervalMs: number;
  private readonly disconnectGraceMs: number;
  private readonly autoReconnect: boolean;
  private readonly logger: (
    level: string,
    message: string,
    data?: unknown,
  ) => void;

  private tracked: Map<string, TrackedVariant> = new Map();
  private started = false;
  private refreshing = false;
  private lastRefreshTime: Date | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCapabilityNotifications = false;
  private pendingResourceUpdates = false;

  constructor(server: McpServer, options: VariantManagerOptions) {
    this.server = server;
    this.ports = options.ports;
    this.reconnectIntervalMs = options.reconnectIntervalMs;
    this.disconnectGraceMs = Math.min(
      Math.max(
        this.reconnectIntervalMs * DISCONNECT_GRACE_MULTIPLIER,
        MIN_DISCONNECT_GRACE_MS,
      ),
      MAX_DISCONNECT_GRACE_MS,
    );
    this.autoReconnect = options.autoReconnect ?? true;
    this.logger = options.logger ?? (() => {});
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.logger(
      'info',
      `[variant-manager] Starting connections (reconnect interval: ${this.reconnectIntervalMs}ms, ports: ${Object.entries(
        this.ports,
      )
        .map(([variant, port]) => `${variant}:${port}`)
        .join(', ')})`,
    );
    void this.refresh();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    this.pendingCapabilityNotifications = false;
    this.pendingResourceUpdates = false;

    const closeTasks = [...this.tracked.entries()].map(
      async ([variant, tracked]) => {
        this.logger(
          'info',
          `[variant-manager] Stopping bundler for ${variant}`,
        );
        this.clearDisconnectCleanupTimer(variant);
        tracked.adapter.unregisterTools(this.server);
        tracked.adapter.unregisterResources(this.server);
        tracked.adapter.unregisterPrompts(this.server);
        await tracked.bundler.close();
      },
    );
    await Promise.all(closeTasks);
    this.tracked.clear();
  }

  getLastRefreshTime(): Date | null {
    return this.lastRefreshTime;
  }

  getReconnectIntervalMs(): number {
    return this.reconnectIntervalMs;
  }

  isRunning(): boolean {
    return this.started;
  }

  getStates(): Map<string, VariantState> {
    const states = new Map<string, VariantState>();
    for (const [variant, port] of Object.entries(this.ports)) {
      const tracked = this.tracked.get(variant);
      if (tracked) {
        const bundlerState = tracked.bundler.getState();
        states.set(variant, {
          port,
          status: bundlerState === 'idle' ? 'connecting' : bundlerState,
          tools: tracked.bundler
            .getTools()
            .map((tool) => `${variant}__${tool}`),
        });
      } else {
        states.set(variant, { port, status: 'not_running', tools: [] });
      }
    }
    return states;
  }

  getCatalog(): Map<string, VariantCatalogEntry> {
    const catalog = new Map<string, VariantCatalogEntry>();

    for (const [variant, port] of Object.entries(this.ports)) {
      const tracked = this.tracked.get(variant);
      if (tracked) {
        const bundlerState = tracked.bundler.getState();
        catalog.set(variant, {
          port,
          status: bundlerState === 'idle' ? 'connecting' : bundlerState,
          tools: tracked.bundler.getToolDefinitions(),
          resources: tracked.bundler.getResourceDefinitions(),
          prompts: tracked.bundler.getPromptDefinitions(),
        });
      } else {
        catalog.set(variant, {
          port,
          status: 'not_running',
          tools: [],
          resources: [],
          prompts: [],
        });
      }
    }

    return catalog;
  }

  async callVariantTool(
    variant: string,
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<CallToolResult | null> {
    let tracked = this.tracked.get(variant);
    if (!tracked) {
      const port = this.ports[variant];
      if (port === undefined) return null;
      await this.addVariant(variant, port);
      tracked = this.tracked.get(variant);
    }

    if (!tracked) return null;
    return tracked.bundler.callTool(tool, args);
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;

    try {
      this.lastRefreshTime = new Date();

      await Promise.all(
        Object.entries(this.ports).map(async ([variant, port]) => {
          const tracked = this.tracked.get(variant);

          if (!tracked) {
            await this.addVariant(variant, port);
            return;
          }

          const state = tracked.bundler.getState();
          if (state === 'disconnected' || state === 'idle') {
            await tracked.bundler.reconnectNow();
          }
        }),
      );
    } finally {
      this.refreshing = false;
    }
  }

  private clearDisconnectCleanupTimer(variant: string): void {
    const tracked = this.tracked.get(variant);
    if (!tracked?.disconnectCleanupTimer) return;

    clearTimeout(tracked.disconnectCleanupTimer);
    tracked.disconnectCleanupTimer = null;
  }

  private scheduleDisconnectCleanup(variant: string): void {
    const tracked = this.tracked.get(variant);
    if (!tracked) return;

    this.clearDisconnectCleanupTimer(variant);
    tracked.disconnectCleanupTimer = setTimeout(() => {
      tracked.disconnectCleanupTimer = null;

      if (tracked.bundler.getState() === 'connected') {
        return;
      }

      tracked.adapter.unregisterTools(this.server);
      tracked.adapter.unregisterResources(this.server);
      tracked.adapter.unregisterPrompts(this.server);
      this.notifyChanged({ capabilitiesChanged: true, resourceUpdates: true });
    }, this.disconnectGraceMs);
  }

  private async syncVariantRegistrations(
    tracked: TrackedVariant,
  ): Promise<void> {
    tracked.adapter.unregisterTools(this.server);
    tracked.adapter.unregisterResources(this.server);
    tracked.adapter.unregisterPrompts(this.server);

    await tracked.adapter.registerTools(this.server);
    await tracked.adapter.registerResources(this.server);
    await tracked.adapter.registerPrompts(this.server);
  }

  private async addVariant(variant: string, port: number): Promise<void> {
    this.logger(
      'info',
      `[variant-manager] Tracking ${variant} on port ${port}`,
    );

    const bundler = new McpBundler({
      name: variant,
      transport: {
        type: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { 'X-Kunobi-Client': '@kunobi/mcp' },
      },
      reconnect: {
        enabled: this.autoReconnect,
        intervalMs: this.reconnectIntervalMs,
        maxRetries: Number.POSITIVE_INFINITY,
      },
      logger: this.logger,
    });

    const adapter = new McpBundlerServerAdapter(bundler, {
      toolPrefix: `${variant}__`,
      promptPrefix: `${variant}__`,
      mapResource: (resource) => ({
        name: buildVariantResourceName(variant, resource),
        uri: buildVariantResourceUri(variant, resource.uri),
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType,
      }),
    });

    const tracked: TrackedVariant = {
      adapter,
      bundler,
      port,
      disconnectCleanupTimer: null,
    };

    this.tracked.set(variant, tracked);

    bundler.on('connected', async () => {
      this.clearDisconnectCleanupTimer(variant);
      await this.syncVariantRegistrations(tracked);
      this.notifyChanged({ capabilitiesChanged: true, resourceUpdates: true });
    });

    bundler.on('disconnected', () => {
      this.scheduleDisconnectCleanup(variant);
      this.notifyChanged({ capabilitiesChanged: false, resourceUpdates: true });
    });

    bundler.on('tools_changed', async () => {
      adapter.unregisterTools(this.server);
      await adapter.registerTools(this.server);
      this.notifyChanged({ capabilitiesChanged: true, resourceUpdates: true });
    });

    bundler.on('resources_changed', async () => {
      adapter.unregisterResources(this.server);
      await adapter.registerResources(this.server);
      this.notifyChanged({ capabilitiesChanged: true, resourceUpdates: true });
    });

    bundler.on('prompts_changed', async () => {
      adapter.unregisterPrompts(this.server);
      await adapter.registerPrompts(this.server);
      this.notifyChanged({ capabilitiesChanged: true, resourceUpdates: true });
    });

    await bundler.reconnectNow();
  }

  private notifyChanged(
    options: { capabilitiesChanged?: boolean; resourceUpdates?: boolean } = {},
  ): void {
    const { capabilitiesChanged = true, resourceUpdates = true } = options;
    this.pendingCapabilityNotifications ||= capabilitiesChanged;
    this.pendingResourceUpdates ||= resourceUpdates;

    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;

      const shouldNotifyCapabilities = this.pendingCapabilityNotifications;
      const shouldNotifyResources = this.pendingResourceUpdates;
      this.pendingCapabilityNotifications = false;
      this.pendingResourceUpdates = false;

      try {
        if (shouldNotifyCapabilities) {
          this.server.server.sendToolListChanged().catch(() => {});
          this.server.server.sendResourceListChanged().catch(() => {});
          this.server.server.sendPromptListChanged().catch(() => {});
        }
        if (shouldNotifyResources) {
          this.server.server
            .sendResourceUpdated({ uri: 'kunobi://status' })
            .catch(() => {});
          this.server.server
            .sendResourceUpdated({ uri: 'kunobi://tools' })
            .catch(() => {});
        }
      } catch {
        // Client may not support notifications yet
      }
    }, 100);
  }
}
