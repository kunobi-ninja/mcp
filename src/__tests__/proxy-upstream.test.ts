import type { EventEmitter } from 'node:events';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProxyDesired, ProxyUpstreamDeps } from '../proxy/upstream.js';
import { ProxyUpstream } from '../proxy/upstream.js';

// --- Fake McpBundler -------------------------------------------------------
//
// We keep the REAL `zodShapeFromJsonSchema` (and the rest of the module) via
// `importOriginal`, and swap out only `McpBundler` with a controllable fake:
// a real `EventEmitter` (so `.on`/`.off` behave exactly like the SDK's, which
// matters for the "late event after teardown" test) whose `getToolDefinitions()`
// is a plain synchronous getter over a mutable `tools` array the test can
// reassign between passes (mirroring the real bundler's cached-list behavior
// on reconnect). Every constructed instance is pushed to `fb.instances` so a
// test can grab "the bundler this ProxyUpstream just created" right after
// `connect()` resolves.
const fb = vi.hoisted(() => ({
  instances: [] as FakeBundlerInstance[],
}));

interface FakeBundlerInstance extends EventEmitter {
  name: string;
  state: 'idle' | 'connecting' | 'connected' | 'disconnected';
  tools: Tool[];
  closeCalls: number;
  calls: Array<{ name: string; args: unknown }>;
}

vi.mock('@kunobi/mcp-bundler', async (importOriginal) => {
  // Dynamically import `node:events` HERE rather than relying on a top-level
  // static import: `vi.mock` factories are hoisted above regular imports, so
  // a class defined in this factory that `extends` a statically-imported
  // binding trips a genuine TDZ (`Cannot access '...' before initialization`)
  // when the factory runs before that import's binding is initialized. A
  // dynamic `import()` inside the factory sidesteps the hoisting order
  // entirely. (The top-level `import type { EventEmitter }` above is
  // type-only and erased at compile time, so it doesn't hit this.)
  const { EventEmitter } = await import('node:events');
  const actual = await importOriginal<typeof import('@kunobi/mcp-bundler')>();

  class FakeBundler extends EventEmitter implements FakeBundlerInstance {
    name: string;
    state: 'idle' | 'connecting' | 'connected' | 'disconnected' = 'idle';
    tools: Tool[] = [];
    closeCalls = 0;
    calls: Array<{ name: string; args: unknown }> = [];

    constructor(options: { name: string }) {
      super();
      this.name = options.name;
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
      this.calls.push({ name, args });
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

// --- Test helpers ------------------------------------------------------

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

function makeDesired(overrides: Partial<ProxyDesired> = {}): ProxyDesired {
  return {
    variant: 'dev',
    uuid: '11111111-2222-3333-4444-555555555555',
    name: 'agw-proxy',
    port: 39999,
    incarnation: 'gen-1',
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<ProxyUpstreamDeps> = {},
): ProxyUpstreamDeps {
  return {
    onToolsChanged: vi.fn(),
    reconnectIntervalMs: 50,
    ...overrides,
  };
}

/** Let queued microtasks (the `registerOp` promise chain) settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function registeredToolNames(server: McpServer): string[] {
  return Object.keys(
    (server as unknown as { _registeredTools?: Record<string, unknown> })
      ._registeredTools ?? {},
  );
}

function registeredResources(server: McpServer): Record<string, unknown> {
  return (
    (server as unknown as { _registeredResources?: Record<string, unknown> })
      ._registeredResources ?? {}
  );
}

function lastFakeBundler(): FakeBundlerInstance {
  const bundler = fb.instances.at(-1);
  if (!bundler) throw new Error('no fake bundler constructed yet');
  return bundler;
}

describe('ProxyUpstream', () => {
  afterEach(() => {
    fb.instances.length = 0;
    vi.restoreAllMocks();
  });

  it('does NOT register on connect; registers only when the registry calls register()', async () => {
    const up = new ProxyUpstream(makeDesired(), makeDeps());
    const server = makeTestServer();

    await up.connect();
    const bundler = lastFakeBundler();
    bundler.tools = [makeTool('t1')];

    // Not auto-registered by connect().
    expect(registeredToolNames(server)).toHaveLength(0);

    await up.register(server, () => 'register');

    const names = registeredToolNames(server);
    expect(names.some((n) => /^dev__agw_/.test(n))).toBe(true);
    expect(registeredResources(server)).toEqual({}); // tools only
  });

  it('teardown awaits an in-flight registration then leaves nothing registered (deferred-race)', async () => {
    const up = new ProxyUpstream(makeDesired(), makeDeps());
    const server = makeTestServer();

    await up.connect();
    const bundler = lastFakeBundler();
    bundler.tools = [makeTool('t1'), makeTool('t2')];

    // register() only *schedules* its work on the `registerOp` promise chain —
    // `.then()` on an already-resolved promise always defers to a microtask,
    // it never runs synchronously. So the moment teardown() is invoked right
    // after, the queued registration pass has NOT started yet: it is
    // genuinely in-flight/queued, not merely "about to be skipped because it
    // never got a chance to run". teardown() sets `torn=true` synchronously
    // (before its own first `await`), so by the time the queued pass actually
    // executes it observes `torn === true` and backs out — and teardown()
    // still `await`s that pass before doing its own final unregister, so
    // ordering can never leave something registered behind.
    const slowRegister = up.register(server, () => 'register');
    const tore = up.teardown(server);
    await Promise.all([slowRegister, tore]);

    expect(registeredToolNames(server)).toHaveLength(0);
    expect(bundler.closeCalls).toBe(1);
  });

  it('a late tools_changed after teardown does not resurrect tools', async () => {
    const up = new ProxyUpstream(makeDesired(), makeDeps());
    const server = makeTestServer();

    await up.connect();
    const bundler = lastFakeBundler();
    bundler.tools = [makeTool('t1')];
    await up.register(server, () => 'register');
    expect(registeredToolNames(server).length).toBeGreaterThan(0);

    await up.teardown(server);

    // Emit directly on the captured bundler instance (teardown() called
    // `off()` on it, so — if listener detachment truly works — this has no
    // live listeners left to react).
    bundler.tools = [makeTool('t1'), makeTool('t2')];
    bundler.emit('tools_changed', bundler.tools);
    await flush();

    expect(registeredToolNames(server)).toHaveLength(0);
  });

  it('NEVER registers a callable_only name (not even transiently), but records it in getDecisions', async () => {
    const up = new ProxyUpstream(makeDesired(), makeDeps());
    const server = makeTestServer();

    await up.connect();
    const bundler = lastFakeBundler();
    bundler.tools = [makeTool('t1'), makeTool('t2')];

    const registerSpy = vi.spyOn(server, 'registerTool');
    await up.register(server, (name) =>
      name.endsWith('t2') ? 'callable_only' : 'register',
    );

    const namesRegistered = registerSpy.mock.calls.map((c) => c[0] as string);
    expect(namesRegistered.some((n) => n.endsWith('t2'))).toBe(false); // never passed to registerTool
    expect(namesRegistered.some((n) => n.endsWith('t1'))).toBe(true);

    expect(
      up.getDecisions().find((d) => d.originalTool === 't2')
        ?.directlyRegistered,
    ).toBe(false);
    expect(
      up.getDecisions().find((d) => d.originalTool === 't1')
        ?.directlyRegistered,
    ).toBe(true);
  });

  it('re-registers on a `connected` reconnect (not only tools_changed)', async () => {
    const onToolsChanged = vi.fn();
    let registeredCountAtNotifyTime = -1;
    onToolsChanged.mockImplementation(() => {
      registeredCountAtNotifyTime = registeredToolNames(server).length;
    });

    const up = new ProxyUpstream(makeDesired(), makeDeps({ onToolsChanged }));
    const server = makeTestServer();

    await up.connect();
    const bundler = lastFakeBundler();
    bundler.tools = [makeTool('t1')];
    await up.register(server, () => 'register');

    const before = registeredToolNames(server).length;

    // The bundler re-lists its tool cache on reconnect and emits `connected`,
    // NOT `tools_changed` — this is exactly the case the brief calls out as
    // easy to miss.
    bundler.tools = [makeTool('t1'), makeTool('t2')];
    bundler.emit('connected');
    await flush();

    const after = registeredToolNames(server).length;
    expect(after).toBeGreaterThan(before);

    // Notification fires AFTER the re-register settles, not before.
    expect(onToolsChanged).toHaveBeenCalled();
    expect(registeredCountAtNotifyTime).toBe(after);
  });

  it('a rejected registration pass does not poison later passes', async () => {
    const up = new ProxyUpstream(makeDesired(), makeDeps());
    const server = makeTestServer();

    await up.connect();
    const bundler = lastFakeBundler();
    bundler.tools = [makeTool('t1')];

    await up
      .register(server, () => {
        throw new Error('boom');
      })
      .catch(() => {});

    // A subsequent good pass still runs:
    await up.register(server, () => 'register');
    expect(registeredToolNames(server).length).toBeGreaterThan(0);
  });

  it('routes a registered tool call through bundler.callTool with the ORIGINAL name', async () => {
    const up = new ProxyUpstream(makeDesired(), makeDeps());
    const server = makeTestServer();

    await up.connect();
    const bundler = lastFakeBundler();
    bundler.tools = [makeTool('t1')];
    await up.register(server, () => 'register');

    const namespacedName = up.namespacedNameFor('t1');
    const registered = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: unknown) => unknown }
        >;
      }
    )._registeredTools[namespacedName];
    expect(registered).toBeDefined();

    await registered.handler({ foo: 'bar' });
    expect(bundler.calls).toEqual([{ name: 't1', args: { foo: 'bar' } }]);
  });

  it('callTool() proxies to the underlying bundler by original name', async () => {
    const up = new ProxyUpstream(makeDesired(), makeDeps());
    await up.connect();
    const bundler = lastFakeBundler();

    await up.callTool('t1', { a: 1 });
    expect(bundler.calls).toEqual([{ name: 't1', args: { a: 1 } }]);
  });

  it('callTool() returns null once torn down (no bundler)', async () => {
    const up = new ProxyUpstream(makeDesired(), makeDeps());
    const server = makeTestServer();
    await up.connect();
    await up.teardown(server);

    expect(await up.callTool('t1', {})).toBeNull();
  });

  it('matchesDesired compares port + incarnation + name', () => {
    const desired = makeDesired();
    const up = new ProxyUpstream(desired, makeDeps());

    expect(up.matchesDesired(desired)).toBe(true);
    expect(up.matchesDesired({ ...desired, port: 1 })).toBe(false);
    expect(up.matchesDesired({ ...desired, incarnation: 'gen-2' })).toBe(false);
    expect(up.matchesDesired({ ...desired, name: 'other' })).toBe(false);
    // uuid is intentionally NOT part of the comparison.
    expect(up.matchesDesired({ ...desired, uuid: 'different-uuid' })).toBe(
      true,
    );
  });

  it('getToolDefinitions() reflects the bundler cache; empty before connect', () => {
    const up = new ProxyUpstream(makeDesired(), makeDeps());
    expect(up.getToolDefinitions()).toEqual([]);
  });
});
