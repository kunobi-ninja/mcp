// NOTE: we do NOT use McpBundlerServerAdapter here. Its registerTools() registers
// EVERY upstream tool and the MCP SDK THROWS on a name collision — so a
// callable_only/colliding name would throw before any prune, and callable_only
// tools would briefly register and emit list-change notifications before removal.
// Instead we register direct-eligible tools ONE AT A TIME, reusing the bundler's
// exported zodShapeFromJsonSchema so schemas match the variant path exactly.
import { McpBundler, zodShapeFromJsonSchema } from '@kunobi/mcp-bundler';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { namespacedToolName, proxyToolPrefix } from './namespace.js';

export interface ProxyDesired {
  variant: string;
  uuid: string;
  name: string;
  port: number;
  incarnation: string;
}

export interface ProxyUpstreamDeps {
  onToolsChanged: () => void;
  reconnectIntervalMs: number;
  logger?: (level: string, message: string, data?: unknown) => void;
}

/** Classify a prospective namespaced name against the CURRENT server. ProxyUpstream
 *  calls this AFTER unregistering its own prior tools, so a re-register never sees
 *  its own names (no self-collision). */
export type ClassifyFn = (
  namespacedName: string,
) => 'register' | 'callable_only';

export interface ToolDecision {
  originalTool: string;
  namespacedName: string;
  directlyRegistered: boolean;
}

export class ProxyUpstream {
  readonly variant: string;
  readonly uuid: string;
  readonly name: string;
  readonly port: number;
  readonly incarnation: string;
  private readonly prefix: string;
  private bundler: McpBundler | null = null;
  private torn = false;
  private registerOp: Promise<void> = Promise.resolve();
  private onConnectedRef!: () => void;
  private onToolsChangedRef!: () => void;
  private serverRef: McpServer | null = null;
  private classifyRef: ClassifyFn | null = null;
  /** Names THIS upstream registered as direct tools (to unregister precisely). */
  private readonly registeredNames = new Set<string>();
  /** FROZEN per-tool decisions from the last pass — the immutable source for
   *  snapshot()/kunobi://tools (never recomputed with a live classify, which
   *  would self-collide once a tool is registered). */
  private decisions: ToolDecision[] = [];

  constructor(
    d: ProxyDesired,
    private deps: ProxyUpstreamDeps,
  ) {
    this.variant = d.variant;
    this.uuid = d.uuid;
    this.name = d.name;
    this.port = d.port;
    this.incarnation = d.incarnation;
    this.prefix = proxyToolPrefix(d.variant, d.name, d.uuid);
  }

  matchesDesired(d: ProxyDesired): boolean {
    return (
      d.port === this.port &&
      d.incarnation === this.incarnation &&
      d.name === this.name
    );
  }

  getToolDefinitions(): Tool[] {
    return this.bundler?.getToolDefinitions() ?? [];
  }

  /** Immutable frozen decisions for kunobi://tools / kunobi_call. */
  getDecisions(): ReadonlyArray<ToolDecision> {
    return this.decisions;
  }

  namespacedNameFor(originalTool: string): string {
    return namespacedToolName(this.prefix, originalTool);
  }

  async connect(): Promise<boolean> {
    const bundler = new McpBundler({
      name: `${this.variant}:agw:${this.uuid.slice(0, 8)}`,
      transport: { type: 'http', url: `http://127.0.0.1:${this.port}/` },
      reconnect: {
        enabled: true,
        intervalMs: this.deps.reconnectIntervalMs,
        maxRetries: Number.POSITIVE_INFINITY,
      },
      logger: this.deps.logger,
    });
    this.bundler = bundler;
    // Re-register on BOTH events. The bundler refreshes its tool cache and emits
    // `connected` on (re)connect, and `tools_changed` on a live upstream change.
    // The manager listens to both (manager.ts:310/321); the proxy MUST too, or a
    // tools change during downtime is lost on reconnect. Notify AFTER re-register.
    const reregister = () => {
      if (this.torn || !this.serverRef || !this.classifyRef) return;
      this.enqueueRegister(this.serverRef, this.classifyRef)
        .then(() => {
          if (!this.torn) this.deps.onToolsChanged();
        })
        .catch(() => {});
    };
    this.onConnectedRef = reregister;
    this.onToolsChangedRef = reregister;
    bundler.on('connected', this.onConnectedRef);
    bundler.on('tools_changed', this.onToolsChangedRef);
    await bundler.reconnectNow();
    return !this.torn && bundler.getState() === 'connected';
  }

  /** Register direct-eligible tools ONLY (never the all-or-throw adapter path).
   *  `classify` runs per prospective name AFTER own prior tools are cleared. */
  register(server: McpServer, classify: ClassifyFn): Promise<void> {
    this.serverRef = server;
    this.classifyRef = classify;
    return this.enqueueRegister(server, classify);
  }

  private enqueueRegister(
    server: McpServer,
    classify: ClassifyFn,
  ): Promise<void> {
    this.registerOp = this.registerOp
      .then(async () => {
        if (this.torn) return;
        // 1. Clear our own prior tools FIRST, so classify() can't see them.
        this.unregisterOwn(server);
        // 2. FREEZE decisions for the current tool set before any registration.
        const tools = this.bundler?.getToolDefinitions() ?? [];
        const decisions: ToolDecision[] = tools.map((t) => {
          const namespacedName = namespacedToolName(this.prefix, t.name);
          return {
            originalTool: t.name,
            namespacedName,
            directlyRegistered: classify(namespacedName) === 'register',
          };
        });
        // 3. Register ONLY direct-eligible tools, one at a time — a callable_only
        //    name is NEVER passed to registerTool, so it can't throw or leak a
        //    transient list-change notification.
        for (const t of tools) {
          if (this.torn) {
            this.unregisterOwn(server);
            return;
          }
          const d = decisions.find((x) => x.originalTool === t.name);
          if (!d?.directlyRegistered) continue;
          const originalName = t.name;
          server.registerTool(
            d.namespacedName,
            {
              title: t.title,
              description: t.description,
              inputSchema: zodShapeFromJsonSchema(t.inputSchema),
              annotations: t.annotations,
            },
            async (args) => {
              // This closure only runs as a registered tool's call handler
              // while this.bundler is set — registerTool is called from
              // enqueueRegister, which only runs while the bundler is
              // connected; unregisterOwn removes the handler on teardown.
              const bundler = this.bundler;
              if (!bundler)
                throw new Error(`[proxy ${this.uuid}] not connected`);
              return bundler.callTool(
                originalName,
                args as Record<string, unknown> | undefined,
              );
            },
          );
          this.registeredNames.add(d.namespacedName);
        }
        this.decisions = decisions; // frozen (includes callable_only entries)
        if (this.torn) this.unregisterOwn(server);
      })
      .catch((err) => {
        // A failed pass must NOT poison the chain — reset it so later refreshes run.
        this.deps.logger?.(
          'error',
          `[proxy ${this.uuid}] register failed: ${String(err)}`,
        );
        this.registerOp = Promise.resolve();
      });
    return this.registerOp;
  }

  private unregisterOwn(server: McpServer): void {
    const internals = server as unknown as {
      _registeredTools?: Record<string, { remove?: () => void }>;
    };
    for (const name of this.registeredNames) {
      internals._registeredTools?.[name]?.remove?.();
    }
    this.registeredNames.clear();
  }

  async callTool(originalTool: string, args: Record<string, unknown>) {
    if (!this.bundler) return null;
    return this.bundler.callTool(originalTool, args);
  }

  async teardown(server: McpServer): Promise<void> {
    this.torn = true;
    if (this.bundler) {
      this.bundler.off('connected', this.onConnectedRef);
      this.bundler.off('tools_changed', this.onToolsChangedRef);
    }
    await this.registerOp.catch(() => {}); // drain in-flight/queued registration
    this.unregisterOwn(server); // final precise unregister after it settles
    await this.bundler?.close();
    this.bundler = null;
  }
}
