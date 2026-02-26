import { McpBundler } from '@kunobi/mcp-bundler';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { probeKunobiServer } from './discovery.js';

export interface ScannerOptions {
  ports: Record<string, number>;
  intervalMs: number;
  missThreshold: number;
  logger?: (level: string, message: string, data?: unknown) => void;
}

export interface VariantState {
  port: number;
  status: 'connected' | 'connecting' | 'disconnected' | 'not_detected';
  tools: string[];
}

interface TrackedVariant {
  bundler: McpBundler;
  port: number;
  missCount: number;
}

export class VariantScanner {
  private readonly server: McpServer;
  private readonly ports: Record<string, number>;
  private readonly intervalMs: number;
  private readonly missThreshold: number;
  private readonly logger: (
    level: string,
    message: string,
    data?: unknown,
  ) => void;

  private tracked: Map<string, TrackedVariant> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;

  constructor(server: McpServer, options: ScannerOptions) {
    this.server = server;
    this.ports = options.ports;
    this.intervalMs = options.intervalMs;
    this.missThreshold = options.missThreshold;
    this.logger = options.logger ?? (() => {});
  }

  start(): void {
    if (this.timer) return;
    this.logger(
      'info',
      `[scanner] Starting scan loop (interval: ${this.intervalMs}ms, ports: ${Object.entries(
        this.ports,
      )
        .map(([v, p]) => `${v}:${p}`)
        .join(', ')})`,
    );

    // Run first scan immediately
    this.scan();

    this.timer = setInterval(() => this.scan(), this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const closeTasks = [...this.tracked.entries()].map(
      async ([variant, { bundler }]) => {
        this.logger('info', `[scanner] Stopping bundler for ${variant}`);
        bundler.unregisterTools(this.server);
        await bundler.close();
      },
    );
    await Promise.all(closeTasks);
    this.tracked.clear();
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
          tools: tracked.bundler.getTools().map((t) => `${variant}/${t}`),
        });
      } else {
        states.set(variant, { port, status: 'not_detected', tools: [] });
      }
    }
    return states;
  }

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;

    try {
      const probeResults = await Promise.all(
        Object.entries(this.ports).map(async ([variant, port]) => {
          const url = `http://127.0.0.1:${port}/mcp`;
          const result = await probeKunobiServer(url);
          return { variant, port, result };
        }),
      );

      const respondedVariants = new Set<string>();

      for (const { variant, port, result } of probeResults) {
        if (result !== null) {
          respondedVariants.add(variant);

          if (!this.tracked.has(variant)) {
            await this.addVariant(variant, port);
          } else {
            // Reset miss count on successful probe
            const tracked = this.tracked.get(variant);
            if (tracked) tracked.missCount = 0;
          }
        }
      }

      // Handle misses for tracked variants that didn't respond
      for (const [variant, tracked] of this.tracked) {
        if (!respondedVariants.has(variant)) {
          tracked.missCount++;
          this.logger(
            'info',
            `[scanner] ${variant} miss ${tracked.missCount}/${this.missThreshold}`,
          );

          if (tracked.missCount >= this.missThreshold) {
            await this.removeVariant(variant);
          }
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  private async addVariant(variant: string, port: number): Promise<void> {
    this.logger('info', `[scanner] Discovered ${variant} on port ${port}`);

    const bundler = new McpBundler({
      name: variant,
      url: `http://127.0.0.1:${port}/mcp`,
      reconnect: {
        enabled: true,
        intervalMs: this.intervalMs,
        maxRetries: Number.POSITIVE_INFINITY,
      },
      logger: this.logger,
    });

    this.tracked.set(variant, { bundler, port, missCount: 0 });

    bundler.on('connected', async () => {
      await bundler.registerTools(this.server);
      this.notifyToolsChanged();
    });

    bundler.on('disconnected', () => {
      bundler.unregisterTools(this.server);
      this.notifyToolsChanged();
    });

    bundler.on('tools_changed', async () => {
      bundler.unregisterTools(this.server);
      await bundler.registerTools(this.server);
      this.notifyToolsChanged();
    });

    bundler.connect().catch(() => {});
  }

  private async removeVariant(variant: string): Promise<void> {
    const tracked = this.tracked.get(variant);
    if (!tracked) return;

    this.logger(
      'info',
      `[scanner] Removing ${variant} (${this.missThreshold} consecutive misses)`,
    );
    tracked.bundler.unregisterTools(this.server);
    await tracked.bundler.close();
    this.tracked.delete(variant);
    this.notifyToolsChanged();
  }

  private notifyToolsChanged(): void {
    try {
      this.server.server.sendToolListChanged().catch(() => {});
    } catch {
      // Client may not support notifications yet
    }
  }
}
