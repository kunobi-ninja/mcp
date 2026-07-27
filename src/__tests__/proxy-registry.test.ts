import type { EventEmitter } from 'node:events';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  ReadResourceResult,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogProxy } from '../proxy/catalog-schema.js';
import { namespacedToolName, proxyToolPrefix } from '../proxy/namespace.js';
import type { VariantManagerLike } from '../proxy/registry.js';
import { ProxyRegistry } from '../proxy/registry.js';

// --- Fake McpBundler ---------------------------------------------------
//
// Same technique as proxy-upstream.test.ts: swap `McpBundler` for a real
// EventEmitter-backed fake so ProxyUpstream (which the registry constructs
// for real — we do NOT fake ProxyUpstream itself) talks to a controllable
// upstream instead of a live socket. Instances are tracked by the port
// embedded in the transport URL so a test can grab "the fake bundler behind
// upstream at port N" and inspect/mutate it.
const fb = vi.hoisted(() => ({
  instances: [] as FakeBundlerInstance[],
}));

interface FakeBundlerInstance extends EventEmitter {
  port: number;
  state: 'idle' | 'connecting' | 'connected' | 'disconnected';
  tools: Tool[];
  closeCalls: number;
}

vi.mock('@kunobi/mcp-bundler', async (importOriginal) => {
  const { EventEmitter } = await import('node:events');
  const actual = await importOriginal<typeof import('@kunobi/mcp-bundler')>();

  class FakeBundler extends EventEmitter implements FakeBundlerInstance {
    port: number;
    state: 'idle' | 'connecting' | 'connected' | 'disconnected' = 'idle';
    tools: Tool[] = [];
    closeCalls = 0;

    constructor(options: { transport?: { url?: string } }) {
      super();
      const url = options.transport?.url ?? '';
      const match = /:(\d+)\//.exec(url);
      this.port = match ? Number(match[1]) : -1;
      fb.instances.push(this);
    }

    getState() {
      return this.state;
    }

    getToolDefinitions(): Tool[] {
      return this.tools;
    }

    async reconnectNow() {
      this.state = 'connected';
      this.emit('connected');
    }

    async callTool(name: string, args: Record<string, unknown> | undefined) {
      return {
        content: [
          { type: 'text' as const, text: `${name}:${JSON.stringify(args)}` },
        ],
      };
    }

    async close() {
      this.closeCalls++;
      this.state = 'idle';
    }
  }

  return { ...actual, McpBundler: FakeBundler };
});

// --- Test helpers --------------------------------------------------------

function makeTestServer(): McpServer {
  return new McpServer(
    { name: 'test', version: '0.0.1' },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
      },
    },
  );
}

function makeTool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: {}, required: [] },
  };
}

function bundlerAtPort(port: number): FakeBundlerInstance {
  const b = [...fb.instances].reverse().find((i) => i.port === port);
  if (!b) throw new Error(`no fake bundler at port ${port}`);
  return b;
}

function present(proxies: CatalogProxy[]): ReadResourceResult {
  return {
    contents: [
      {
        uri: 'kunobi://mcp-proxies',
        text: JSON.stringify({ schemaVersion: 1, proxies }),
      },
    ],
  };
}

function revokeUnsupportedVersion(): ReadResourceResult {
  return {
    contents: [
      {
        uri: 'kunobi://mcp-proxies',
        text: JSON.stringify({ schemaVersion: 2, proxies: [] }),
      },
    ],
  };
}

function proxy(overrides: Partial<CatalogProxy> = {}): CatalogProxy {
  return {
    uuid: 'u1',
    name: 'agw-proxy',
    port: 41000,
    incarnation: 'gen-1',
    ...overrides,
  };
}

/** Scriptable fake VariantManager. `readImpl` is read fresh on every call, so
 *  a test can reassign it mid-flight (e.g. to prove a coalesced second pass
 *  observes newer state than the first). */
class FakeManager implements VariantManagerLike {
  connectedVariants: string[] = [];
  reconnectIntervalMs = 5;
  disconnectGraceMs = 1_000;
  notifyToolListChanged = vi.fn();
  readImpl: (
    variant: string,
    uri: string,
  ) => Promise<ReadResourceResult | null> = async () => null;
  readCalls: Array<{ variant: string; uri: string }> = [];

  listConnectedVariants(): string[] {
    return [...this.connectedVariants];
  }

  async readVariantResource(
    variant: string,
    uri: string,
  ): Promise<ReadResourceResult | null> {
    this.readCalls.push({ variant, uri });
    return this.readImpl(variant, uri);
  }

  getReconnectIntervalMs(): number {
    return this.reconnectIntervalMs;
  }

  getDisconnectGraceMs(): number {
    return this.disconnectGraceMs;
  }
}

/** Let queued microtasks (a ProxyUpstream `registerOp` promise chain
 *  triggered by a bundler event) settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
} {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('ProxyRegistry', () => {
  afterEach(() => {
    fb.instances.length = 0;
    vi.restoreAllMocks();
  });

  it('adds proxies on present, removes them when the catalog goes empty (authoritative)', async () => {
    const server = makeTestServer();
    const manager = new FakeManager();
    manager.connectedVariants = ['dev'];
    manager.readImpl = async () => present([proxy({ port: 41001 })]);

    const registry = new ProxyRegistry({ server, manager });
    await registry.reconcile();

    expect(registry.get('dev', 'u1')).toBeDefined();
    expect(registry.snapshot()).toHaveLength(1);
    const bundler = bundlerAtPort(41001);
    expect(bundler.closeCalls).toBe(0);

    manager.readImpl = async () => present([]);
    await registry.reconcile();

    expect(registry.get('dev', 'u1')).toBeUndefined();
    expect(registry.snapshot()).toHaveLength(0);
    expect(bundler.closeCalls).toBe(1);
    expect(manager.notifyToolListChanged).toHaveBeenCalled();
  });

  it('replaces the upstream when incarnation changes (same uuid/port)', async () => {
    const server = makeTestServer();
    const manager = new FakeManager();
    manager.connectedVariants = ['dev'];
    manager.readImpl = async () =>
      present([proxy({ port: 41002, incarnation: 'gen-1' })]);

    const registry = new ProxyRegistry({ server, manager });
    await registry.reconcile();
    const first = registry.get('dev', 'u1');
    expect(first).toBeDefined();
    const oldBundler = bundlerAtPort(41002);

    manager.readImpl = async () =>
      present([proxy({ port: 41002, incarnation: 'gen-2' })]);
    await registry.reconcile();

    const second = registry.get('dev', 'u1');
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(oldBundler.closeCalls).toBe(1);
  });

  it('keeps last-known-good on transient, revokes after TTL (fake clock)', async () => {
    const server = makeTestServer();
    const manager = new FakeManager();
    manager.connectedVariants = ['dev'];
    manager.readImpl = async () => present([proxy({ port: 41003 })]);

    let clock = 0;
    const registry = new ProxyRegistry({
      server,
      manager,
      ttlMs: 1_000,
      now: () => clock,
    });

    await registry.reconcile(); // t=0: present -> added
    expect(registry.get('dev', 'u1')).toBeDefined();

    manager.readImpl = async () => null; // unavailable
    clock = 100;
    await registry.reconcile(); // stamp = 100, elapsed 0 < ttl -> kept
    expect(registry.get('dev', 'u1')).toBeDefined();

    clock = 1_099; // elapsed 999 < ttl -> still kept
    await registry.reconcile();
    expect(registry.get('dev', 'u1')).toBeDefined();

    clock = 1_100; // elapsed 1000 >= ttl -> revoked
    await registry.reconcile();
    expect(registry.get('dev', 'u1')).toBeUndefined();
  });

  it('does NOT reset firstFailureAt on repeated transient failures', async () => {
    const server = makeTestServer();
    const manager = new FakeManager();
    manager.connectedVariants = ['dev'];
    manager.readImpl = async () => present([proxy({ port: 41004 })]);

    let clock = 0;
    const registry = new ProxyRegistry({
      server,
      manager,
      ttlMs: 600,
      now: () => clock,
    });

    await registry.reconcile(); // t=0: added

    manager.readImpl = async () => null;
    clock = 10;
    await registry.reconcile(); // stamp = 10

    clock = 500;
    await registry.reconcile(); // repeated failure; stamp must stay 10 (elapsed 490 < 600)
    expect(registry.get('dev', 'u1')).toBeDefined();

    clock = 610; // if stamp had reset to 500, elapsed would be 110 (< 600) -> still kept.
    // Since stamp must stay 10, elapsed is 600 -> revoked.
    await registry.reconcile();
    expect(registry.get('dev', 'u1')).toBeUndefined();
  });

  it('revokes a variant proxies on unsupported schemaVersion', async () => {
    const server = makeTestServer();
    const manager = new FakeManager();
    manager.connectedVariants = ['dev'];
    manager.readImpl = async () => present([proxy({ port: 41005 })]);

    const registry = new ProxyRegistry({ server, manager, ttlMs: 100_000 });
    await registry.reconcile();
    expect(registry.get('dev', 'u1')).toBeDefined();

    manager.readImpl = async () => revokeUnsupportedVersion();
    await registry.reconcile(); // revoke is immediate, not subject to ttl

    expect(registry.get('dev', 'u1')).toBeUndefined();
  });

  it('skips direct registration for a colliding namespaced name but keeps it callable', async () => {
    const server = makeTestServer();
    const manager = new FakeManager();
    manager.connectedVariants = ['dev'];

    const uuid = 'u1';
    const variant = 'dev';
    const name = 'agw-proxy';
    const originalTool = 'shared_tool';
    const prefix = proxyToolPrefix(variant, name, uuid);
    const collidingName = namespacedToolName(prefix, originalTool);

    // Pre-register a tool under the EXACT name this proxy's tool would
    // namespace to, simulating a name already claimed elsewhere.
    server.registerTool(collidingName, {}, async () => ({ content: [] }));

    manager.readImpl = async () =>
      present([proxy({ uuid, name, port: 41006 })]);

    const registry = new ProxyRegistry({ server, manager });
    await registry.reconcile();

    const bundler = bundlerAtPort(41006);
    bundler.tools = [makeTool(originalTool)];
    // The catalog/incarnation is unchanged, so a further reconcile() would
    // skip this upstream entirely (matchesDesired). Drive the upstream's own
    // reactive re-register path instead, exactly as the real bundler would
    // on a live tool-list change.
    bundler.emit('tools_changed', bundler.tools);
    await flush();

    const entry = registry.snapshot().find((e) => e.uuid === uuid);
    expect(entry).toBeDefined();
    const tool = entry?.tools.find((t) => t.originalTool === originalTool);
    expect(tool).toBeDefined();
    expect(tool?.dynamicToolName).toBe(collidingName);
    expect(tool?.directlyRegistered).toBe(false); // callable_only, not dropped
  });

  it('keys by (variant, uuid): same uuid in two variants yields two independent entries', async () => {
    const server = makeTestServer();
    const manager = new FakeManager();
    manager.connectedVariants = ['dev', 'unstable'];
    manager.readImpl = async (variant) =>
      variant === 'dev'
        ? present([proxy({ uuid: 'shared', port: 41007 })])
        : present([proxy({ uuid: 'shared', port: 41008 })]);

    const registry = new ProxyRegistry({ server, manager });
    await registry.reconcile();

    const devEntry = registry.get('dev', 'shared');
    const unstableEntry = registry.get('unstable', 'shared');
    expect(devEntry).toBeDefined();
    expect(unstableEntry).toBeDefined();
    expect(devEntry).not.toBe(unstableEntry);
    expect(registry.snapshot()).toHaveLength(2);
  });

  it('tears down a variant that drops out of listConnectedVariants after the disconnect grace, not before', async () => {
    const server = makeTestServer();
    const manager = new FakeManager();
    manager.disconnectGraceMs = 1_000;
    manager.connectedVariants = ['dev'];
    manager.readImpl = async () => present([proxy({ port: 41010 })]);

    let clock = 0;
    const registry = new ProxyRegistry({ server, manager, now: () => clock });

    await registry.reconcile(); // t=0: added
    expect(registry.get('dev', 'u1')).toBeDefined();
    const bundler = bundlerAtPort(41010);

    // Variant drops out of the connected set entirely (distinct from a
    // connected-but-unavailable read, which is the ttlMs path above). The
    // grace timer starts from the first reconcile() that OBSERVES the
    // absence, not from clock 0.
    manager.connectedVariants = [];
    await registry.reconcile(); // t=0: absence first observed -> since=0

    clock = 999; // elapsed 999 < grace (1000) -> kept
    await registry.reconcile();
    expect(registry.get('dev', 'u1')).toBeDefined();
    expect(bundler.closeCalls).toBe(0);

    clock = 1_000; // elapsed 1000 >= grace -> torn down
    await registry.reconcile();
    expect(registry.get('dev', 'u1')).toBeUndefined();
    expect(bundler.closeCalls).toBe(1);
  });

  it('a forced reconcile during an in-flight one coalesces (not dropped)', async () => {
    const server = makeTestServer();
    const manager = new FakeManager();
    manager.connectedVariants = ['dev'];

    const firstRead = deferred<ReadResourceResult | null>();
    let callCount = 0;
    manager.readImpl = async () => {
      callCount++;
      if (callCount === 1) return firstRead.promise;
      // Second (coalesced) pass observes a DIFFERENT, newer state than the
      // first pass was given — proving the extra pass actually re-read
      // rather than being silently dropped.
      return present([]);
    };

    const registry = new ProxyRegistry({ server, manager });

    // `reconcile()` flips its `reconciling` guard synchronously, before any
    // await — so calling it twice back-to-back (no intervening await)
    // deterministically hits the "already in flight" branch on the second
    // call; no timing assumptions needed.
    const passA = registry.reconcile();
    const passB = registry.reconcile();

    // Release pass A's read with data that (if it were the only pass) would
    // add an entry.
    firstRead.resolve(present([proxy({ port: 41009 })]));

    await Promise.all([passA, passB]);

    // The coalesced second pass ran with the newer (empty) catalog, so the
    // proxy added transiently by pass A's data must be gone by the time both
    // promises resolve.
    expect(registry.snapshot()).toHaveLength(0);
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});
