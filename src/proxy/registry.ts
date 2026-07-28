import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { CatalogProxy } from './catalog-schema.js';
import { classifyRead } from './catalog-schema.js';
import { classifyRegistration } from './namespace.js';
import type { ProxyDesired } from './upstream.js';
import { ProxyUpstream } from './upstream.js';

export const PROXY_CATALOG_URI = 'kunobi://mcp-proxies';

/** No response / an error was surfaced as opaque text for `ttlMs` before we
 *  give up on a variant's proxies (see catalog-schema's "Observability
 *  caveat": the bundler swallows read errors into text, so we can't tell a
 *  genuine transient hiccup from something more permanent — a grace window
 *  is the only safe default). */
const DEFAULT_TRANSIENT_TTL_MS = 15_000;

/** The subset of `VariantManager` the registry depends on — kept narrow so
 *  tests can supply a fake without constructing a real manager/server. */
export interface VariantManagerLike {
  listConnectedVariants(): string[];
  readVariantResource(
    variant: string,
    uri: string,
  ): Promise<ReadResourceResult | null>;
  notifyToolListChanged(): void;
  getReconnectIntervalMs(): number;
  getDisconnectGraceMs(): number;
}

export interface ProxyRegistryDeps {
  server: McpServer;
  manager: VariantManagerLike;
  /** How long a variant may stay `unavailable` (transient read failure)
   *  before its proxies are revoked. Defaults to `DEFAULT_TRANSIENT_TTL_MS`. */
  ttlMs?: number;
  now?: () => number;
  logger?: (level: string, message: string, data?: unknown) => void;
}

export interface ProxySnapshotTool {
  originalTool: string;
  dynamicToolName: string;
  directlyRegistered: boolean;
}

export interface ProxySnapshotEntry {
  variant: string;
  uuid: string;
  name: string;
  tools: ProxySnapshotTool[];
}

export class ProxyRegistry {
  private readonly server: McpServer;
  private readonly manager: VariantManagerLike;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly logger: (
    level: string,
    message: string,
    data?: unknown,
  ) => void;

  /** NESTED map, keyed by (variant, uuid) — never a composite string key. */
  private readonly entries = new Map<string, Map<string, ProxyUpstream>>();
  /** First time a connected variant's catalog read went `unavailable`,
   *  never reset while failures continue — only cleared on a `present`/
   *  `revoke` outcome or once the TTL fires. */
  private readonly failStamps = new Map<string, number>();
  /** First time a variant with tracked entries dropped out of
   *  `listConnectedVariants()`; cleared once it reconnects. */
  private readonly variantAbsentSince = new Map<string, number>();

  private reconciling = false;
  private pendingForce = false;
  private currentRun: Promise<void> = Promise.resolve();

  constructor(deps: ProxyRegistryDeps) {
    this.server = deps.server;
    this.manager = deps.manager;
    this.ttlMs = deps.ttlMs ?? DEFAULT_TRANSIENT_TTL_MS;
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? (() => {});
  }

  get(variant: string, uuid: string): ProxyUpstream | undefined {
    return this.entries.get(variant)?.get(uuid);
  }

  snapshot(): ProxySnapshotEntry[] {
    const out: ProxySnapshotEntry[] = [];
    for (const [variant, variantMap] of this.entries) {
      for (const [uuid, up] of variantMap) {
        out.push({
          variant,
          uuid,
          name: up.name,
          tools: up.getDecisions().map((d) => ({
            originalTool: d.originalTool,
            dynamicToolName: d.namespacedName,
            directlyRegistered: d.directlyRegistered,
          })),
        });
      }
    }
    return out;
  }

  async teardownAll(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const variantMap of this.entries.values()) {
      for (const up of variantMap.values()) {
        tasks.push(up.teardown(this.server));
      }
    }
    await Promise.all(tasks);
    this.entries.clear();
    this.failStamps.clear();
    this.variantAbsentSince.clear();
  }

  /** Idempotent, coalescing reconcile. If a call arrives while one is already
   *  in flight, it does not run a second overlapping pass — it flags the
   *  in-flight run to loop once more after it finishes, and awaits the same
   *  promise the running pass returns (so the extra pass is never dropped). */
  async reconcile(): Promise<void> {
    if (this.reconciling) {
      this.pendingForce = true;
      return this.currentRun;
    }

    this.reconciling = true;
    const run = async (): Promise<void> => {
      do {
        this.pendingForce = false;
        try {
          await this.runOnce();
        } catch (err) {
          // reconcile() MUST never reject: kunobi_refresh awaits it, and the
          // background poll launches it fire-and-forget (`void reconcile()`).
          // A throw from a proxy teardown/register (or any future read path)
          // would otherwise fail the refresh tool or raise an unhandledRejection.
          // Swallow to a log; the next pass — the forced one below, or the next
          // poll — retries. State is left as runOnce mutated it (idempotent).
          this.logger(
            'error',
            `[proxy-registry] reconcile pass failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      } while (this.pendingForce);
    };
    this.currentRun = run().finally(() => {
      this.reconciling = false;
    });
    return this.currentRun;
  }

  private async runOnce(): Promise<void> {
    let changed = false;
    const now = this.now();
    const connected = new Set(this.manager.listConnectedVariants());

    changed = (await this.reconcileAbsentVariants(connected, now)) || changed;

    for (const variant of connected) {
      changed = (await this.reconcileConnectedVariant(variant, now)) || changed;
    }

    if (changed) {
      this.manager.notifyToolListChanged();
    }
  }

  /** Variants that used to have entries but are no longer connected —
   *  applies the manager's disconnect-grace policy before tearing down. */
  private async reconcileAbsentVariants(
    connected: Set<string>,
    now: number,
  ): Promise<boolean> {
    let changed = false;
    const graceMs = this.manager.getDisconnectGraceMs();
    const known = new Set([
      ...this.entries.keys(),
      ...this.variantAbsentSince.keys(),
    ]);

    for (const variant of known) {
      if (connected.has(variant)) {
        this.variantAbsentSince.delete(variant);
        continue;
      }
      const variantMap = this.entries.get(variant);
      if (!variantMap || variantMap.size === 0) {
        this.variantAbsentSince.delete(variant);
        continue;
      }
      let since = this.variantAbsentSince.get(variant);
      if (since === undefined) {
        since = now;
        this.variantAbsentSince.set(variant, now);
      }
      if (now - since >= graceMs) {
        if (await this.revokeVariant(variant)) changed = true;
        this.variantAbsentSince.delete(variant);
      }
    }

    return changed;
  }

  private async reconcileConnectedVariant(
    variant: string,
    now: number,
  ): Promise<boolean> {
    const outcome = classifyRead(
      await this.manager.readVariantResource(variant, PROXY_CATALOG_URI),
    );

    if (outcome.kind === 'unavailable') {
      let stamp = this.failStamps.get(variant);
      if (stamp === undefined) {
        stamp = now;
        this.failStamps.set(variant, now);
      }
      if (now - stamp >= this.ttlMs) {
        const changed = await this.revokeVariant(variant);
        this.failStamps.delete(variant);
        return changed;
      }
      return false;
    }

    if (outcome.kind === 'revoke') {
      this.failStamps.delete(variant);
      return this.revokeVariant(variant);
    }

    // present
    this.failStamps.delete(variant);
    return this.applyDesired(variant, outcome.catalog.proxies);
  }

  private async applyDesired(
    variant: string,
    desiredList: CatalogProxy[],
  ): Promise<boolean> {
    let changed = false;
    const desiredByUuid = new Map(desiredList.map((d) => [d.uuid, d]));
    let variantMap = this.entries.get(variant);
    if (!variantMap) {
      variantMap = new Map();
      this.entries.set(variant, variantMap);
    }

    // Remove entries no longer in the desired set (authoritative).
    for (const uuid of [...variantMap.keys()]) {
      if (!desiredByUuid.has(uuid)) {
        const up = variantMap.get(uuid);
        if (up) await up.teardown(this.server);
        variantMap.delete(uuid);
        changed = true;
      }
    }

    for (const [uuid, d] of desiredByUuid) {
      const desired: ProxyDesired = {
        variant,
        uuid,
        name: d.name,
        port: d.port,
        incarnation: d.incarnation,
      };
      const existing = variantMap.get(uuid);
      if (existing?.matchesDesired(desired)) continue; // unchanged

      if (existing) {
        await existing.teardown(this.server);
        variantMap.delete(uuid);
      }

      const up = new ProxyUpstream(desired, {
        onToolsChanged: () => this.manager.notifyToolListChanged(),
        reconnectIntervalMs: this.manager.getReconnectIntervalMs(),
        logger: this.logger,
      });
      // `register()` must run unconditionally — it's the ONLY place
      // ProxyUpstream wires up serverRef/classifyRef, which its own
      // 'connected'/'tools_changed' listeners require. McpBundler.connect()
      // resolves after a single attempt and merely SCHEDULES a background
      // retry on failure, so gating register() on connectedOk would leave a
      // temporarily-unreachable upstream's refs unset — its later
      // background reconnect would then silently no-op forever. When
      // disconnected, register() just enqueues zero direct registrations
      // (harmless) while still wiring the refs for the eventual reconnect.
      const connectedOk = await up.connect();
      await up.register(this.server, (name) =>
        classifyRegistration(this.server, name),
      );
      if (!connectedOk) {
        this.logger(
          'warn',
          `[proxy ${uuid}] initial connect failed for variant ${variant}; will retry in the background`,
        );
      }
      variantMap.set(uuid, up);
      changed = true;
    }

    if (variantMap.size === 0) {
      this.entries.delete(variant);
    }

    return changed;
  }

  /** Teardown + remove every entry for a variant. Returns whether anything
   *  was actually removed (so callers can fold it into `changed`). */
  private async revokeVariant(variant: string): Promise<boolean> {
    const variantMap = this.entries.get(variant);
    if (!variantMap || variantMap.size === 0) {
      this.entries.delete(variant);
      return false;
    }
    await Promise.all(
      [...variantMap.values()].map((up) => up.teardown(this.server)),
    );
    this.entries.delete(variant);
    return true;
  }
}
