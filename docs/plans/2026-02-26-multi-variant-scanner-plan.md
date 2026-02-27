# Multi-Variant Scanner Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Evolve @kunobi/mcp from a single-target proxy to a multi-variant hub that discovers and multiplexes multiple running Kunobi instances.

**Architecture:** A `VariantScanner` periodically probes known ports (3030, 3200–3600), confirms each is Kunobi via `serverInfo.name`, and manages a pool of `McpBundler` instances. Each bundler registers tools with a `variant/` prefix. The MCP server remains a single stdio entry point.

**Tech Stack:** TypeScript, @kunobi/mcp-bundler (unchanged), @modelcontextprotocol/sdk, vitest

**Design doc:** `docs/plans/2026-02-26-multi-variant-scanner-design.md`

---

### Task 1: Update discovery.ts — Port Map and Probe Validation

**Files:**
- Modify: `src/discovery.ts`
- Test: `src/__tests__/discovery.test.ts`

**Context:** Currently `discovery.ts` has `DEFAULT_MCP_URL = 'http://127.0.0.1:3030/mcp'` and `getMcpUrl()` returns a single URL. `probeMcpServer()` sends an `initialize` request but doesn't check `serverInfo.name`. We need to:
1. Export the variant→port map
2. Make the probe validate that the server identifies as Kunobi
3. Export config-reading helpers for env vars
4. Keep `findKunobiVariants()`, `launchHint()`, `getLaunchCommand()` unchanged

**Step 1: Write failing tests for port map and config helpers**

Add to `src/__tests__/discovery.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_VARIANT_PORTS,
  getScanConfig,
  probeKunobiServer,
} from '../discovery.js';

describe('DEFAULT_VARIANT_PORTS', () => {
  it('contains all known variants', () => {
    expect(DEFAULT_VARIANT_PORTS).toEqual({
      legacy: 3030,
      stable: 3200,
      unstable: 3300,
      dev: 3400,
      local: 3500,
      e2e: 3600,
    });
  });
});

describe('getScanConfig', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [
      'MCP_KUNOBI_INTERVAL',
      'MCP_KUNOBI_PORTS',
      'MCP_KUNOBI_ENABLED',
      'MCP_KUNOBI_MISS_THRESHOLD',
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('returns defaults when no env vars are set', () => {
    const config = getScanConfig();
    expect(config.ports).toEqual(DEFAULT_VARIANT_PORTS);
    expect(config.intervalMs).toBe(5000);
    expect(config.missThreshold).toBe(3);
    expect(config.enabled).toBe(true);
  });

  it('respects MCP_KUNOBI_INTERVAL', () => {
    process.env.MCP_KUNOBI_INTERVAL = '10000';
    expect(getScanConfig().intervalMs).toBe(10000);
  });

  it('respects MCP_KUNOBI_PORTS to filter variants', () => {
    process.env.MCP_KUNOBI_PORTS = '3400,3500';
    const config = getScanConfig();
    expect(config.ports).toEqual({ dev: 3400, local: 3500 });
  });

  it('respects MCP_KUNOBI_ENABLED=false', () => {
    process.env.MCP_KUNOBI_ENABLED = 'false';
    expect(getScanConfig().enabled).toBe(false);
  });

  it('respects MCP_KUNOBI_MISS_THRESHOLD', () => {
    process.env.MCP_KUNOBI_MISS_THRESHOLD = '5';
    expect(getScanConfig().missThreshold).toBe(5);
  });
});

describe('probeKunobiServer', () => {
  it('returns null for unreachable port', async () => {
    const result = await probeKunobiServer('http://127.0.0.1:19999/mcp');
    expect(result).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test -- --reporter verbose`
Expected: FAIL — `DEFAULT_VARIANT_PORTS`, `getScanConfig`, `probeKunobiServer` not exported

**Step 3: Implement port map, config helpers, and updated probe**

In `src/discovery.ts`:

1. Add the port map constant:

```typescript
export const DEFAULT_VARIANT_PORTS: Record<string, number> = {
  legacy: 3030,
  stable: 3200,
  unstable: 3300,
  dev: 3400,
  local: 3500,
  e2e: 3600,
};
```

2. Add `ScanConfig` type and `getScanConfig()`:

```typescript
export interface ScanConfig {
  ports: Record<string, number>;
  intervalMs: number;
  missThreshold: number;
  enabled: boolean;
}

export function getScanConfig(): ScanConfig {
  const enabled = process.env.MCP_KUNOBI_ENABLED !== 'false';
  const intervalMs = Number(process.env.MCP_KUNOBI_INTERVAL) || 5000;
  const missThreshold = Number(process.env.MCP_KUNOBI_MISS_THRESHOLD) || 3;

  let ports = { ...DEFAULT_VARIANT_PORTS };
  const portsEnv = process.env.MCP_KUNOBI_PORTS;
  if (portsEnv) {
    const allowed = new Set(portsEnv.split(',').map((p) => Number(p.trim())));
    ports = Object.fromEntries(
      Object.entries(ports).filter(([, port]) => allowed.has(port)),
    );
  }

  return { ports, intervalMs, missThreshold, enabled };
}
```

3. Replace `probeMcpServer` with `probeKunobiServer` that validates serverInfo:

```typescript
export async function probeKunobiServer(
  url: string,
): Promise<{ tools: string[]; serverName: string } | null> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'kunobi-mcp-probe', version: '0.0.1' },
        },
      }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return null;

    const initBody = (await response.json()) as {
      result?: { serverInfo?: { name?: string } };
    };
    const serverName = initBody.result?.serverInfo?.name ?? '';
    if (!serverName.toLowerCase().includes('kunobi')) return null;

    // Probe for tools
    const toolsResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(response.headers.has('mcp-session-id')
          ? { 'mcp-session-id': response.headers.get('mcp-session-id') ?? '' }
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!toolsResponse.ok) return { tools: [], serverName };

    const body = (await toolsResponse.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    return {
      tools: body.result?.tools?.map((t) => t.name) ?? [],
      serverName,
    };
  } catch {
    return null;
  }
}
```

4. Update `detectKunobi()` to use `probeKunobiServer` instead of `probeMcpServer`.

**Step 4: Run tests to verify they pass**

Run: `pnpm test -- --reporter verbose`
Expected: ALL PASS

**Step 5: Run typecheck and lint**

Run: `pnpm typecheck && pnpm check`
Expected: No errors

**Step 6: Commit**

```bash
git add src/discovery.ts src/__tests__/discovery.test.ts
git commit -m "feat(discovery): add variant port map, scan config, and kunobi-validated probe"
```

---

### Task 2: Create scanner.ts — VariantScanner Class

**Files:**
- Create: `src/scanner.ts`
- Test: `src/__tests__/scanner.test.ts`

**Context:** This is the core new module. It manages the scan loop and bundler pool. It depends on `probeKunobiServer` from discovery.ts (Task 1). The bundler API we use:
- `new McpBundler({ name, transport: { type: 'http', url }, reconnect, logger })`
- `bundler.connect()`, `bundler.close()`
- `bundler.registerTools(server, prefix)`, `bundler.unregisterTools(server)`
- `bundler.getState()` returns `'idle' | 'connecting' | 'connected' | 'disconnected'`
- `bundler.getTools()` returns `string[]`
- Events: `'connected'`, `'disconnected'`, `'tools_changed'`

**Step 1: Write failing tests for VariantScanner**

Create `src/__tests__/scanner.test.ts`:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi, afterEach } from 'vitest';
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
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test -- --reporter verbose`
Expected: FAIL — `VariantScanner` module not found

**Step 3: Implement VariantScanner**

Create `src/scanner.ts`:

```typescript
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
  private readonly logger: (level: string, message: string, data?: unknown) => void;

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
    this.logger('info', `[scanner] Starting scan loop (interval: ${this.intervalMs}ms, ports: ${Object.entries(this.ports).map(([v, p]) => `${v}:${p}`).join(', ')})`);

    // Run first scan immediately
    this.scan();

    this.timer = setInterval(() => this.scan(), this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const closeTasks = [...this.tracked.entries()].map(async ([variant, { bundler }]) => {
      this.logger('info', `[scanner] Stopping bundler for ${variant}`);
      bundler.unregisterTools(this.server);
      await bundler.close();
    });
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
            const tracked = this.tracked.get(variant)!;
            tracked.missCount = 0;
          }
        }
      }

      // Handle misses for tracked variants that didn't respond
      for (const [variant, tracked] of this.tracked) {
        if (!respondedVariants.has(variant)) {
          tracked.missCount++;
          this.logger('info', `[scanner] ${variant} miss ${tracked.missCount}/${this.missThreshold}`);

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
      transport: { type: 'http', url: `http://127.0.0.1:${port}/mcp` },
      reconnect: {
        enabled: true,
        intervalMs: this.intervalMs,
        maxRetries: Number.POSITIVE_INFINITY,
      },
      logger: this.logger,
    });

    this.tracked.set(variant, { bundler, port, missCount: 0 });

    const prefix = `${variant}/`;

    bundler.on('connected', async () => {
      await bundler.registerTools(this.server, prefix);
      this.notifyToolsChanged();
    });

    bundler.on('disconnected', () => {
      bundler.unregisterTools(this.server);
      this.notifyToolsChanged();
    });

    bundler.on('tools_changed', async () => {
      bundler.unregisterTools(this.server);
      await bundler.registerTools(this.server, prefix);
      this.notifyToolsChanged();
    });

    bundler.connect().catch(() => {});
  }

  private async removeVariant(variant: string): Promise<void> {
    const tracked = this.tracked.get(variant);
    if (!tracked) return;

    this.logger('info', `[scanner] Removing ${variant} (${this.missThreshold} consecutive misses)`);
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
```

**Step 4: Run tests to verify they pass**

Run: `pnpm test -- --reporter verbose`
Expected: ALL PASS

**Step 5: Run typecheck and lint**

Run: `pnpm typecheck && pnpm check`
Expected: No errors

**Step 6: Commit**

```bash
git add src/scanner.ts src/__tests__/scanner.test.ts
git commit -m "feat: add VariantScanner for multi-variant discovery and bundler management"
```

---

### Task 3: Update status.ts — Multi-Variant Status

**Files:**
- Modify: `src/tools/status.ts`
- Modify: `src/__tests__/status.test.ts`

**Context:** `registerStatusTool` currently calls `detectKunobi()` which returns a single state. It needs to accept a `VariantScanner` and report all variant states. The signature changes from `registerStatusTool(server)` to `registerStatusTool(server, scanner)`.

**Step 1: Update tests**

Replace `src/__tests__/status.test.ts` contents:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import type { VariantScanner, VariantState } from '../scanner.js';
import { registerStatusTool } from '../tools/status.js';

type ServerInternals = {
  _registeredTools: Record<
    string,
    {
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        openWorldHint?: boolean;
      };
      handler: (args: unknown) => Promise<{
        content: Array<{ type: string; text: string }>;
      }>;
    }
  >;
};

function createServer(): McpServer {
  return new McpServer(
    { name: 'test', version: '0.0.1' },
    { capabilities: { tools: { listChanged: true } } },
  );
}

function mockScanner(states: Record<string, VariantState>): VariantScanner {
  return {
    getStates: () => new Map(Object.entries(states)),
  } as unknown as VariantScanner;
}

describe('registerStatusTool (multi-variant)', () => {
  it('registers kunobi_status tool on the server', () => {
    const server = createServer();
    const scanner = mockScanner({});
    registerStatusTool(server, scanner);

    const tool = (server as unknown as ServerInternals)._registeredTools
      .kunobi_status;
    expect(tool).toBeDefined();
    expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it('reports connected variants', async () => {
    const server = createServer();
    const scanner = mockScanner({
      dev: { port: 3400, status: 'connected', tools: ['dev/foo', 'dev/bar'] },
      e2e: { port: 3600, status: 'not_detected', tools: [] },
    });
    registerStatusTool(server, scanner);

    const tool = (server as unknown as ServerInternals)._registeredTools
      .kunobi_status;
    const result = await tool.handler({});
    expect(result.content[0].text).toContain('dev');
    expect(result.content[0].text).toContain('3400');
    expect(result.content[0].text).toContain('connected');
    expect(result.content[0].text).toContain('e2e');
    expect(result.content[0].text).toContain('not detected');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test -- --reporter verbose`
Expected: FAIL — `registerStatusTool` doesn't accept scanner param

**Step 3: Update status.ts implementation**

Replace `src/tools/status.ts`:

```typescript
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VariantScanner } from '../scanner.js';
import { findKunobiVariants } from '../discovery.js';

function formatMultiStatus(scanner: VariantScanner): string {
  const states = scanner.getStates();
  const lines: string[] = ['Kunobi MCP Hub Status', '─────────────────────', 'Variants:'];

  for (const [variant, state] of states) {
    const icon = state.status === 'connected' ? '✓' : '✗';
    const detail =
      state.status === 'connected'
        ? `connected, ${state.tools.length} tools`
        : state.status === 'connecting'
          ? 'connecting...'
          : state.status === 'disconnected'
            ? 'disconnected (reconnecting)'
            : 'not detected';
    lines.push(`  ${icon} ${variant.padEnd(10)} (port ${state.port}) — ${detail}`);
  }

  const installed = findKunobiVariants();
  if (installed.length > 0) {
    lines.push('', `Installed on system: ${installed.join(', ')}`);
  }

  return lines.join('\n');
}

export function registerStatusTool(
  server: McpServer,
  scanner: VariantScanner,
): void {
  server.registerTool(
    'kunobi_status',
    {
      description:
        'Check the connection status of all Kunobi variants. Reports which variants are connected, their ports, and available tools.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      return {
        content: [{ type: 'text' as const, text: formatMultiStatus(scanner) }],
      };
    },
  );
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm test -- --reporter verbose`
Expected: status.test.ts PASS (server.test.ts may fail — we fix that in Task 5)

**Step 5: Commit**

```bash
git add src/tools/status.ts src/__tests__/status.test.ts
git commit -m "feat(status): update kunobi_status tool for multi-variant reporting"
```

---

### Task 4: Update server.ts — Wire Scanner

**Files:**
- Modify: `src/server.ts`

**Context:** Replace the single `McpBundler` with `VariantScanner`. The scanner manages all bundlers internally. Built-in tools/prompts/resource get the scanner injected.

**Step 1: Rewrite server.ts**

Key changes:
1. Import `VariantScanner` and `getScanConfig`
2. Remove single `McpBundler` creation and event wiring
3. Create `VariantScanner` with config from env
4. Pass `scanner` to `registerStatusTool`
5. Update resource and prompts to use scanner state
6. Update help text to document new env vars
7. Start scanner after stdio connects

```typescript
#!/usr/bin/env node

import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { findKunobiVariants, getScanConfig, launchHint } from './discovery.js';
import { VariantScanner } from './scanner.js';
import { registerLaunchTool } from './tools/launch.js';
import { registerStatusTool } from './tools/status.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const arg = process.argv[2];
if (arg === '--help' || arg === '-h') {
  console.log(`Kunobi MCP server v${version} — connects AI assistants to the Kunobi desktop app.

Usage (in Claude settings):
  {
    "mcpServers": {
      "kunobi": {
        "command": "npx",
        "args": ["-y", "@kunobi/mcp"]
      }
    }
  }

Options:
  --help, -h          Show this help message
  --version, -v       Show version number
  --install, -i       Register this MCP server with your AI clients
  --uninstall, -u     Remove this MCP server from your AI clients

Environment:
  MCP_KUNOBI_INTERVAL       Scan interval in ms (default: 5000)
  MCP_KUNOBI_PORTS          Comma-separated port filter (default: all known)
  MCP_KUNOBI_ENABLED        Set "false" to disable scanning
  MCP_KUNOBI_MISS_THRESHOLD Misses before teardown (default: 3)`);
  process.exit(0);
}

if (arg === '--version' || arg === '-v') {
  console.log(version);
  process.exit(0);
}

if (arg === '--install' || arg === '-i') {
  const { install } = await import('@kunobi/mcp-installer');
  await install({
    name: 'kunobi',
    command: 'npx',
    args: ['-y', '@kunobi/mcp'],
  });
  process.exit(0);
}

if (arg === '--uninstall' || arg === '-u') {
  const { uninstall } = await import('@kunobi/mcp-installer');
  await uninstall({ name: 'kunobi' });
  process.exit(0);
}

const scanConfig = getScanConfig();

const server = new McpServer(
  { name: 'kunobi', version },
  { capabilities: { tools: { listChanged: true }, logging: {} } },
);

const scanner = new VariantScanner(server, {
  ports: scanConfig.ports,
  intervalMs: scanConfig.intervalMs,
  missThreshold: scanConfig.missThreshold,
  logger: (level, message) => {
    if (level === 'error' || level === 'warn') {
      server.server
        .sendLoggingMessage({ level: level === 'error' ? 'error' : 'warning', logger: 'kunobi-mcp', data: message })
        .catch(() => {});
    }
  },
});

registerStatusTool(server, scanner);
registerLaunchTool(server);

// Resource: passive way for the LLM to check Kunobi state
server.registerResource(
  'kunobi_status',
  'kunobi://status',
  {
    description: 'Current Kunobi connection state across all variants',
    mimeType: 'application/json',
  },
  async () => {
    const states: Record<string, unknown> = {};
    for (const [variant, state] of scanner.getStates()) {
      states[variant] = state;
    }
    return {
      contents: [
        {
          uri: 'kunobi://status',
          mimeType: 'application/json',
          text: JSON.stringify(
            { variants: states, installedVariants: findKunobiVariants(), scanInterval: scanConfig.intervalMs },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// Prompt: guide user through Kunobi setup
server.registerPrompt(
  'kunobi-setup',
  { description: 'Check Kunobi status and provide setup instructions' },
  async () => {
    const states = scanner.getStates();
    const connected = [...states.entries()].filter(([, s]) => s.status === 'connected');
    const installed = findKunobiVariants();

    let instructions: string;
    if (connected.length > 0) {
      const summary = connected.map(([v, s]) => `${v} (${s.tools.length} tools)`).join(', ');
      instructions = `Kunobi is connected. Active variants: ${summary}.${installed.length > 0 ? ` Installed: ${installed.join(', ')}.` : ''}`;
    } else if (installed.length > 0) {
      instructions = `Kunobi is installed but no variants are running (found: ${installed.join(', ')}). ${launchHint()}`;
    } else {
      instructions = 'Kunobi is not installed. Download it from https://kunobi.ninja/downloads and install it on your system.';
    }

    return {
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: instructions } }],
    };
  },
);

// Prompt: diagnose Kunobi connection issues
server.registerPrompt(
  'kunobi-doctor',
  { description: 'Diagnose why Kunobi tools are unavailable and suggest fixes' },
  async () => {
    const states = scanner.getStates();
    const installed = findKunobiVariants();
    const steps: string[] = [];

    const connected = [...states.entries()].filter(([, s]) => s.status === 'connected');
    const disconnected = [...states.entries()].filter(([, s]) => s.status === 'disconnected');

    if (connected.length > 0) {
      steps.push(`Connected variants: ${connected.map(([v]) => v).join(', ')}`);
    }
    if (disconnected.length > 0) {
      steps.push(`Disconnected (reconnecting): ${disconnected.map(([v]) => v).join(', ')}`);
    }
    if (connected.length === 0 && disconnected.length === 0) {
      if (installed.length === 0) {
        steps.push(
          'No Kunobi variants detected.',
          '1. Download Kunobi from https://kunobi.ninja/downloads',
          '2. Install and launch the application',
          '3. Enable MCP in Kunobi Settings',
        );
      } else {
        steps.push(
          `Kunobi is installed (${installed.join(', ')}) but no variants are running.`,
          `1. ${launchHint()}`,
          '2. Wait a few seconds for MCP to initialize',
          '3. Tools will appear automatically once connected',
        );
      }
    }

    steps.push('', `Scanning ports: ${[...states.entries()].map(([v, s]) => `${v}:${s.port}`).join(', ')}`);
    steps.push(`Scan interval: ${scanConfig.intervalMs}ms`);

    return {
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: steps.join('\n') } }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

// Start scanning — non-blocking, bundlers connect in background
scanner.start();

// Non-blocking version check
import('@kunobi/mcp-installer')
  .then(({ checkForUpdate }) => checkForUpdate('@kunobi/mcp', version))
  .then((update) => {
    if (update?.updateAvailable) {
      server.server
        .sendLoggingMessage({
          level: 'warning',
          logger: 'kunobi-mcp',
          data: `A newer version of @kunobi/mcp is available (${update.current} → ${update.latest}). Restart the MCP server to pick it up.`,
        })
        .catch(() => {});
    }
  })
  .catch(() => {});
```

**Step 2: Run typecheck and lint**

Run: `pnpm typecheck && pnpm check`
Expected: No errors

**Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat(server): replace single bundler with VariantScanner for multi-variant support"
```

---

### Task 5: Fix server.test.ts — Update Tests for New Architecture

**Files:**
- Modify: `src/__tests__/server.test.ts`

**Context:** The existing server.test.ts duplicates prompt/resource registration inline (copy-paste from server.ts). With the new architecture, the prompts and resource are registered in `server.ts` using the scanner. The test needs to be updated to reflect the new registration pattern — mocking or injecting a scanner.

**Step 1: Rewrite server.test.ts**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import type { VariantScanner, VariantState } from '../scanner.js';
import { registerStatusTool } from '../tools/status.js';
import { registerLaunchTool } from '../tools/launch.js';

type ServerInternals = {
  _registeredTools: Record<
    string,
    {
      annotations?: {
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        openWorldHint?: boolean;
      };
      handler: (args: unknown) => Promise<unknown>;
    }
  >;
};

function createServer(): McpServer {
  return new McpServer(
    { name: 'test', version: '0.0.1' },
    { capabilities: { tools: { listChanged: true } } },
  );
}

function mockScanner(states: Record<string, VariantState>): VariantScanner {
  return {
    getStates: () => new Map(Object.entries(states)),
  } as unknown as VariantScanner;
}

describe('built-in tools registration', () => {
  it('kunobi_status has correct annotations', () => {
    const server = createServer();
    const scanner = mockScanner({});
    registerStatusTool(server, scanner);

    const tool = (server as unknown as ServerInternals)._registeredTools
      .kunobi_status;
    expect(tool.annotations).toBeDefined();
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.annotations?.destructiveHint).toBe(false);
    expect(tool.annotations?.openWorldHint).toBe(false);
  });

  it('kunobi_launch is registered', () => {
    const server = createServer();
    registerLaunchTool(server);

    const tool = (server as unknown as ServerInternals)._registeredTools
      .kunobi_launch;
    expect(tool).toBeDefined();
  });
});
```

**Step 2: Run all tests**

Run: `pnpm test -- --reporter verbose`
Expected: ALL PASS

**Step 3: Run full check suite**

Run: `pnpm typecheck && pnpm check && pnpm test`
Expected: All pass

**Step 4: Commit**

```bash
git add src/__tests__/server.test.ts
git commit -m "test: update server tests for multi-variant architecture"
```

---

### Task 6: Clean Up discovery.ts — Remove Single-URL Remnants

**Files:**
- Modify: `src/discovery.ts`
- Modify: `src/__tests__/discovery.test.ts`

**Context:** After Tasks 1-5, `getMcpUrl()`, the old `probeMcpServer()`, and the single-URL `detectKunobi()` are no longer used by server.ts. Clean them up:
- Remove `DEFAULT_MCP_URL`, `getMcpUrl()`, old `probeMcpServer()`
- Simplify or remove `detectKunobi()` if nothing references it anymore
- Keep `findKunobiVariants()`, `launchHint()`, `getLaunchCommand()` — still used
- Update discovery tests to remove `getMcpUrl` tests

**Step 1: Search for remaining usages**

Run: `grep -r 'getMcpUrl\|detectKunobi\|probeMcpServer\|DEFAULT_MCP_URL' src/` (excluding tests)
Remove anything no longer imported.

**Step 2: Clean up exports and tests**

Remove dead code and dead tests. Keep `probeKunobiServer` (used by scanner).

**Step 3: Run all tests**

Run: `pnpm test -- --reporter verbose`
Expected: ALL PASS

**Step 4: Run full check suite**

Run: `pnpm typecheck && pnpm check`
Expected: No errors

**Step 5: Commit**

```bash
git add src/discovery.ts src/__tests__/discovery.test.ts
git commit -m "refactor(discovery): remove single-URL remnants, keep multi-variant exports"
```

---

### Task 7: End-to-End Verification

**Files:** None (verification only)

**Step 1: Run full test suite with coverage**

Run: `pnpm test -- --reporter verbose --coverage`
Expected: All tests pass, reasonable coverage

**Step 2: Build**

Run: `pnpm build`
Expected: Clean build, no errors

**Step 3: Typecheck and lint**

Run: `pnpm typecheck && pnpm check`
Expected: No errors

**Step 4: Manual smoke test (optional)**

Run: `node dist/server.js --help`
Expected: Shows updated help with new env vars

**Step 5: Commit if any fixes were needed**

```bash
git add -A
git commit -m "chore: fix any remaining issues from multi-variant migration"
```
